import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { ApiError } from "../http/errors.js";

/*
 * Reads a job posting from a link (job boards, LinkedIn posts, company career pages) for the frontend and AI assistants.
 * Structured data first (JSON-LD JobPosting, meta tags), then an optional Groq pass over the page text that tidies the
 * fields and finds the HR email. Saves nothing: callers save the job with POST /jobs.
 *
 * Only public http(s) addresses are fetched, and every redirect is checked again, so a link can't make the server
 * call itself, the local network or cloud metadata endpoints.
 */

export type ImportedJob = {
  title: string;
  company: string;
  location: string;
  workMode: "ONSITE" | "HYBRID" | "REMOTE" | "";
  description: string;
  jobUrl: string;
  /** HR / recruiter email found in the post ("" when none) */
  hrEmail: string;
  /** True when the details were read by the AI (Groq), false for the rule-based fallback */
  ai: boolean;
};

type WorkMode = ImportedJob["workMode"];

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g;
/** Addresses that never belong to a person you can apply to */
const NOT_A_CONTACT = /^(no-?reply|do-?not-?reply|notifications?|privacy|abuse|support|feedback|info@linkedin)/i;

export async function importJobFromUrl(url: string): Promise<ImportedJob> {
  const html = await fetchPublicPage(url);
  const jsonLd = parseJsonLd(html);

  const titleFallback = metaContent(html, "property", "og:title") || metaContent(html, "name", "twitter:title")
    || (/<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? "");
  let title = decodeEntities(String(jsonLd?.title ?? titleFallback)).split("|")[0].split(" - ")[0].trim();

  let company = (jsonLd?.hiringOrganization as { name?: string } | undefined)?.name
    ?? (metaContent(html, "property", "og:site_name") || "");
  if (!company) {
    const m = /class="[^"]*top-card-layout__company[^"]*"[^>]*>\s*<[^>]+>\s*([^<]+)/i.exec(html);
    company = m ? decodeEntities(m[1]).trim() : "";
  }

  let location = (jsonLd?.jobLocation as { address?: { addressLocality?: string } } | undefined)?.address?.addressLocality ?? "";
  if (!location) {
    const m = /class="[^"]*description__job-criteria-text[^"]*"[^>]*>\s*([^<]+)/i.exec(html)
      ?? /class="[^"]*topcard__flavor--bullet[^"]*"[^>]*>\s*([^<]+)/i.exec(html);
    location = m ? decodeEntities(m[1]).trim() : "";
  }

  const requirements = jsonLd?.applicantLocationRequirements;
  let workMode: WorkMode = Array.isArray(requirements) && requirements.length > 0 ? toWorkMode(String(requirements[0])) : "";
  if (!workMode) workMode = toWorkMode(`${location} ${title} ${html.slice(0, 4000)}`);

  let description = jsonLd?.description ? stripTags(decodeEntities(String(jsonLd.description))) : "";
  if (!description) {
    const m = /class="[^"]*description__text[^"]*"[^>]*>([\s\S]{20,8000}?)<\/section>/i.exec(html)
      ?? /class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]{20,8000}?)<\/div>/i.exec(html);
    description = m ? stripTags(decodeEntities(m[1])) : "";
  }
  if (!description) {
    description = decodeEntities(metaContent(html, "property", "og:description") || metaContent(html, "name", "description"));
  }

  const text = pageText(html);
  const ai = await extractWithAi(`${description}\n\n${text}`, { title, company });
  if (ai) {
    title = ai.title || title;
    company = ai.company || company;
    location = ai.location || location;
    workMode = ai.workMode || workMode;
    description = ai.description || description;
  }
  const hrEmail = ai?.hrEmail || findEmails(`${description}\n${text}`)[0] || "";

  if (!title && !company && !description) {
    throw new ApiError(422, "JOB_NOT_FOUND_AT_URL",
      "Could not read job details from this link. The site may require login, or it isn't a job posting.");
  }
  return {
    // Titles end up in email subjects: one line. A post's og:title is often the whole post.
    title: oneLine(title).slice(0, 200),
    company: SITE_NAMES.has(oneLine(company).toLowerCase()) ? "" : oneLine(company).slice(0, 200),
    location: location.slice(0, 200),
    workMode,
    description: description.slice(0, 20_000),
    jobUrl: url,
    hrEmail,
    ai: !!ai,
  };
}

/** og:site_name values that name the website, not the employer */
const SITE_NAMES = new Set(["linkedin", "indeed", "naukri", "naukri.com", "glassdoor", "wellfound", "internshala", "instahyre", "x", "twitter", "facebook"]);

/** The first non-empty line, whitespace collapsed. */
export function oneLine(value: string): string {
  return (value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "").replace(/\s+/g, " ");
}

// ---- fetching ----

async function fetchPublicPage(raw: string): Promise<string> {
  let url = parseHttpUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          // LinkedIn serves pre-rendered HTML to crawlers
          "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new ApiError(504, "URL_TIMEOUT", "The page took too long to respond. Try again.");
      }
      throw new ApiError(502, "URL_UNREACHABLE", "Could not reach the link.");
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = parseHttpUrl(new URL(response.headers.get("location")!, url).toString());
      continue;
    }
    if (!response.ok) {
      throw new ApiError(422, "URL_FAILED",
        `The page responded with status ${response.status}. The site may require login for this post.`);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_HTML_BYTES) throw new ApiError(422, "PAGE_TOO_LARGE", "The page is too large to read.");
    return (await response.text()).slice(0, MAX_HTML_BYTES);
  }
  throw new ApiError(422, "TOO_MANY_REDIRECTS", "The link redirects too many times.");
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiError(400, "VALIDATION_FAILED", "url must be a full link starting with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError(400, "VALIDATION_FAILED", "url must be a full link starting with https://");
  }
  if (url.username || url.password) throw new ApiError(400, "VALIDATION_FAILED", "url must not contain credentials");
  return url;
}

async function assertPublicHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new ApiError(502, "URL_UNREACHABLE", "Could not reach the link.");
  if (addresses.some(isPrivateAddress)) throw new ApiError(400, "URL_NOT_ALLOWED", "Only public web links can be imported.");
}

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

// ---- reading the page ----

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<\/(div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function metaContent(html: string, attr: string, value: string): string {
  const m = new RegExp(`<meta[^>]+(?:${attr})=["']${value}["'][^>]*content=["']([^"']+)["']`, "i").exec(html)
    ?? new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:${attr})=["']${value}["']`, "i").exec(html);
  return m ? decodeEntities(m[1]) : "";
}

function parseJsonLd(html: string): Record<string, unknown> | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    try {
      const obj = JSON.parse(m[1]) as Record<string, unknown>;
      if (obj["@type"] === "JobPosting" || obj.title) return obj;
    } catch {
      // not JSON, try the next block
    }
  }
  return null;
}

function toWorkMode(raw: string): WorkMode {
  const s = raw.toLowerCase();
  if (s.includes("remote")) return "REMOTE";
  if (s.includes("hybrid")) return "HYBRID";
  if (s.includes("onsite") || s.includes("on-site") || s.includes("in-office")) return "ONSITE";
  return "";
}

/** Every contact email in the text, in order, without duplicates or system addresses. */
export function findEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(EMAIL)) {
    const email = match[0].replace(/\.+$/, "").toLowerCase();
    if (!NOT_A_CONTACT.test(email) && !email.endsWith("@linkedin.com") && !/\.(png|jpe?g|gif|webp)$/.test(email)) seen.add(email);
  }
  return [...seen];
}

function pageText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// ---- AI pass (Groq, optional) ----

const SYSTEM_PROMPT = `You extract job details from the text of a job posting or a social media post about a job.
Reply with ONLY a JSON object with exactly these keys:
{"title": string, "company": string, "location": string, "workMode": "ONSITE" | "HYBRID" | "REMOTE" | "",
 "description": string, "hrEmail": string}
Rules:
- Use only information in the text. Never invent anything. Use "" when something isn't stated.
- title: the role, e.g. "React.js & Java Developer Intern". No company name or emojis in it.
- company: the hiring company. If a person hires for their own project, use their name.
- location: city/country as written, or "Remote" when it's remote only.
- workMode: REMOTE, HYBRID or ONSITE only when the text says so, otherwise "".
- description: the posting's own text about the role, cleaned up: keep responsibilities, requirements, stipend or
  salary, and how to apply; drop hashtags, emojis, "like and share" lines and unrelated feed text. Plain text with
  line breaks, at most 4000 characters.
- hrEmail: the email address to send an application or resume to, exactly as written in the text, else "".`;

type Extracted = Omit<ImportedJob, "jobUrl" | "ai">;

/** Null when GROQ_API_KEY isn't set or the call fails; the rule-based result is used instead. */
async function extractWithAi(text: string, hints: { title: string; company: string }): Promise<Extracted | null> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return null;
  const input = [hints.title && `Page title: ${hints.title}`, hints.company && `Site/company hint: ${hints.company}`,
    "Page text:", text.slice(0, 14_000)].filter(Boolean).join("\n");
  let parsed: Record<string, unknown>;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile",
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: input }],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      // Status only: the page text could contain personal data
      console.warn(`Groq extraction failed with status ${response.status}`);
      return null;
    }
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const workMode = str(parsed.workMode, 10).toUpperCase();
  // The email must literally be in the page: anything else is a guess
  const emails = findEmails(text);
  const aiEmail = str(parsed.hrEmail, 254).toLowerCase();
  return {
    title: str(parsed.title, 200),
    company: str(parsed.company, 200),
    location: str(parsed.location, 200),
    workMode: workMode === "ONSITE" || workMode === "HYBRID" || workMode === "REMOTE" ? workMode : "",
    description: str(parsed.description, 20_000),
    hrEmail: emails.includes(aiEmail) ? aiEmail : (emails[0] ?? ""),
  };
}
