import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

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

const REQUEST_HEADERS = {
  // LinkedIn serves pre-rendered HTML to crawlers
  "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const TIMEOUT_MS = 10_000;

const notAllowed = () => new ApiError(400, "URL_NOT_ALLOWED", "Only public web links can be imported.");
const unreachable = () => new ApiError(502, "URL_UNREACHABLE", "Could not reach the link.");

async function fetchPublicPage(raw: string): Promise<string> {
  let url = parseHttpUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // IP literals skip DNS (and so publicOnlyLookup); host names are checked when the connection is made
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && isPrivateAddress(literal)) throw notAllowed();
    const response = await getPage(url);
    if (response.status >= 300 && response.status < 400 && response.location) {
      url = parseHttpUrl(new URL(response.location, url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(422, "URL_FAILED",
        `The page responded with status ${response.status}. The site may require login for this post.`);
    }
    return response.body;
  }
  throw new ApiError(422, "TOO_MANY_REDIRECTS", "The link redirects too many times.");
}

/** Marks a connection refused by publicOnlyLookup. */
class BlockedAddressError extends Error {}

/**
 * dns.lookup that refuses non-public addresses. Used as the connection's own lookup, so the address checked is the
 * address connected to: a host name can't resolve to a public address for a check and a private one for the request.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    if (addresses.length === 0) return callback(new Error("No address"), "", 0);
    if (addresses.some((entry) => isPrivateAddress(entry.address))) return callback(new BlockedAddressError(), "", 0);
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

type Page = { status: number; location: string | null; body: string };

/** One GET, no redirects followed; the body is read up to MAX_HTML_BYTES. */
function getPage(url: URL): Promise<Page> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(url, { headers: REQUEST_HEADERS, lookup: publicOnlyLookup, agent: false },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        if (status < 200 || status >= 300) {
          response.resume();
          return finish(() => resolve({ status, location, body: "" }));
        }
        if (Number(response.headers["content-length"] ?? 0) > MAX_HTML_BYTES) {
          response.destroy();
          return finish(() => reject(new ApiError(422, "PAGE_TOO_LARGE", "The page is too large to read.")));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => finish(() => resolve({ status, location, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("data", (chunk: Buffer) => {
          const room = MAX_HTML_BYTES - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += chunk.length;
          if (size >= MAX_HTML_BYTES) {
            response.destroy();
            done();
          }
        });
        response.on("end", done);
        response.on("error", () => finish(() => reject(unreachable())));
      });
    const timer = setTimeout(() => {
      request.destroy();
      finish(() => reject(new ApiError(504, "URL_TIMEOUT", "The page took too long to respond. Try again.")));
    }, TIMEOUT_MS);
    let settled = false;
    function finish(settle: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    }
    request.on("error", (error) => finish(() => reject(error instanceof BlockedAddressError ? notAllowed() : unreachable())));
  });
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

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, documentation, multicast and reserved ranges. */
const BLOCKED = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
// Unspecified/loopback, discard-only, Teredo, documentation, unique local, link-local, old site-local, multicast
for (const [network, prefix] of [["::", 127], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["fc00::", 7],
  ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

/**
 * True for any address that isn't public, including IPv4 addresses written inside IPv6 (::ffff:7f00:1, ::127.0.0.1,
 * 64:ff9b::…, 2002:…), which reach the same IPv4 host. Anything unparseable counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return BLOCKED.check(address, "ipv4");
  const words = ipv6Words(address);
  if (!words) return true;
  const ipv4 = embeddedIpv4(words);
  if (ipv4 !== null) return BLOCKED.check(ipv4, "ipv4");
  return BLOCKED.check(words.map((word) => word.toString(16)).join(":"), "ipv6");
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail and a zone id allowed), or null. */
function ipv6Words(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0]!;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((part) => part > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half ? half.split(":") : []);
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!all.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return all.map((group) => parseInt(group, 16));
}

/** The IPv4 address an IPv6 address stands for (mapped, compatible, NAT64, 6to4), or null. */
function embeddedIpv4(words: number[]): string | null {
  const ipv4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  const zero = (from: number, to: number) => words.slice(from, to).every((word) => word === 0);
  if (zero(0, 5) && words[5] === 0xffff) return ipv4(words[6]!, words[7]!); // ::ffff:a.b.c.d
  if (zero(0, 4) && words[4] === 0xffff && words[5] === 0) return ipv4(words[6]!, words[7]!); // ::ffff:0:a.b.c.d
  if (zero(0, 6)) return ipv4(words[6]!, words[7]!); // ::a.b.c.d (also :: and ::1, both blocked as IPv4)
  if (words[0] === 0x64 && words[1] === 0xff9b && zero(2, 6)) return ipv4(words[6]!, words[7]!); // NAT64
  if (words[0] === 0x2002) return ipv4(words[1]!, words[2]!); // 6to4
  return null;
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
  const model = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
  let parsed: Record<string, unknown>;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: input }],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      // Status, model and Groq's error code only: the page text could contain personal data
      const code = ((await response.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      console.warn(`Groq extraction failed with status ${response.status} (model ${model}${code ? `, ${code}` : ""})`);
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
