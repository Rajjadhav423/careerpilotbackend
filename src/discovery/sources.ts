import type { TechRole } from "./classify.js";
import { cityName, countryName, type Place } from "./places.js";
import { extractSkills } from "./skills.js";

/*
 * Job sources for Find jobs: public company boards, free job feeds and (with an API key) aggregators. Only fixed
 * hosts are called and user input never goes into these requests; searching happens on the cached results
 * (see job-search.ts). Sources that need an API key are skipped until the key is set in the environment.
 */

export type WorkplaceType = "ONSITE" | "HYBRID" | "REMOTE" | "UNSPECIFIED";

/** A posting before tech-role classification. Descriptions are not kept: small, fast cache entries. */
export type RawPosting = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  department: string | null;
  workplaceType: WorkplaceType;
  url: string;
  /** ISO date-time */
  postedAt: string | null;
  source: string;
  /** Structured country/city from the source; otherwise derived from `location` later */
  places?: Place[];
  /** A hiring contact the company published in the post itself (e.g. Hacker News "Who is hiring?") */
  contactEmail?: string;
  /** Known tech skills the post mentions (title, department and description), for the resume match */
  skills: string[];
};

/** A tech posting as the API returns it. */
export type JobPosting = RawPosting & {
  techRole: TechRole;
  places: Place[];
  /** Other sources listing the same job (duplicates merged into this one) */
  alsoOn?: string[];
};

/** "company": a company's own job board (direct apply link); "feed": a job board; "aggregator": a search engine. */
export type SourceKind = "company" | "feed" | "aggregator";

export type Source = {
  key: string;
  /** Provider name shown to users, e.g. "Greenhouse", "Adzuna" */
  provider: string;
  /** Board label, e.g. "greenhouse:stripe" or "adzuna" */
  board: string;
  company: string;
  kind: SourceKind;
};

/** Where postings come from; tests replace it with fakes. */
export type JobSources = {
  list(): Source[];
  load(key: string): Promise<RawPosting[]>;
};

export const defaultJobSources: JobSources = { list: listSources, load };

/** Seconds each source stays fresh, kept polite for free feeds that ask for few calls. */
const FRESH_SECONDS: Record<string, number> = {
  company: 15 * 60,
  remotive: 6 * 3600, // Remotive asks for at most ~4 calls a day
  remoteok: 3 * 3600,
  hackernews: 6 * 3600, // one thread a month
  arbeitnow: 3600,
  themuse: 3600,
  himalayas: 3600,
  jobicy: 3 * 3600, // updated a few times a day
  workingnomads: 3600,
  weworkremotely: 3600,
};

export const freshMs = (key: string) => (FRESH_SECONDS[key.includes(":") ? "company" : key] ?? 3600) * 1000;

type BoardProvider = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "recruitee";

/**
 * Public company job boards (no API key). The first group matches the backend (careerpilot.discovery.boards);
 * the rest add companies hiring in India, Japan and Germany, and global remote-friendly companies.
 * Every slug was checked to return jobs. To add one: provider, the company's board id, display name.
 */
const COMPANY_BOARDS: [provider: BoardProvider, slug: string, company: string][] = [
  ["greenhouse", "groww", "Groww"],
  ["greenhouse", "druva", "Druva"],
  ["greenhouse", "hackerrank", "HackerRank"],
  ["greenhouse", "stripe", "Stripe"],
  ["greenhouse", "databricks", "Databricks"],
  ["greenhouse", "cloudflare", "Cloudflare"],
  ["lever", "cred", "CRED"],
  ["lever", "meesho", "Meesho"],
  ["lever", "zeta", "Zeta"],
  ["lever", "paytm", "Paytm"],
  ["ashby", "sarvam", "Sarvam AI"],
  ["ashby", "notion", "Notion"],
  ["ashby", "openai", "OpenAI"],
  // India
  ["greenhouse", "razorpaysoftwareprivatelimited", "Razorpay"],
  ["lever", "fampay", "FamPay"],
  ["lever", "mindtickle", "Mindtickle"],
  ["smartrecruiters", "Freshworks", "Freshworks"],
  // Japan
  ["greenhouse", "paypay", "PayPay"],
  // Germany
  ["greenhouse", "n26", "N26"],
  ["greenhouse", "celonis", "Celonis"],
  ["greenhouse", "getyourguide", "GetYourGuide"],
  ["greenhouse", "contentful", "Contentful"],
  ["greenhouse", "traderepublicbank", "Trade Republic"],
  ["greenhouse", "hellofresh", "HelloFresh"],
  ["greenhouse", "sumup", "SumUp"],
  ["smartrecruiters", "DeliveryHero", "Delivery Hero"],
  // Global (many remote or India/Japan/Germany roles)
  ["greenhouse", "gitlab", "GitLab"],
  ["greenhouse", "coinbase", "Coinbase"],
  ["greenhouse", "airbnb", "Airbnb"],
  ["greenhouse", "rubrik", "Rubrik"],
  ["ashby", "cohere", "Cohere"],
  ["ashby", "linear", "Linear"],
  ["ashby", "ramp", "Ramp"],
  ["smartrecruiters", "ServiceNow", "ServiceNow"],
  ["recruitee", "bunq", "bunq"],
  // More India
  ["greenhouse", "inmobi", "InMobi"],
  ["greenhouse", "clear", "Clear (ClearTax)"],
  ["greenhouse", "slice", "slice"],
  ["lever", "fi", "Fi Money"],
  ["ashby", "navi", "Navi"],
];

const PROVIDER_NAMES: Record<BoardProvider, string> = {
  greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", smartrecruiters: "SmartRecruiters", recruitee: "Recruitee",
};

/** Every source. All are free and need no API key. */
export function listSources(): Source[] {
  const boards: Source[] = COMPANY_BOARDS.map(([provider, slug, company]) => ({
    key: `${provider}:${slug}`,
    provider: PROVIDER_NAMES[provider],
    board: `${provider}:${slug}`,
    company,
    kind: "company",
  }));
  const feed = (key: string, provider: string): Source => ({ key, provider, board: key, company: "Many companies", kind: "feed" });
  return [
    ...boards,
    feed("remotive", "Remotive"),
    feed("remoteok", "Remote OK"),
    feed("hackernews", "Hacker News"),
    feed("arbeitnow", "Arbeitnow"),
    feed("themuse", "The Muse"),
    feed("himalayas", "Himalayas"),
    feed("jobicy", "Jobicy"),
    feed("workingnomads", "Working Nomads"),
    feed("weworkremotely", "We Work Remotely"),
  ];
}

export async function load(key: string): Promise<RawPosting[]> {
  if (key.includes(":")) {
    const [provider, slug] = key.split(":");
    const board = COMPANY_BOARDS.find(([p, s]) => p === provider && s === slug);
    if (!board) throw new Error(`Unknown board ${key}`);
    if (provider === "greenhouse") return greenhouse(slug, board[2]);
    if (provider === "lever") return lever(slug, board[2]);
    if (provider === "smartrecruiters") return smartRecruiters(slug, board[2]);
    if (provider === "recruitee") return recruitee(slug, board[2]);
    return ashby(slug, board[2]);
  }
  switch (key) {
    case "remotive": return remotive();
    case "remoteok": return remoteOk();
    case "hackernews": return hackerNews();
    case "arbeitnow": return arbeitnow();
    case "themuse": return theMuse();
    case "himalayas": return himalayas();
    case "jobicy": return jobicy();
    case "workingnomads": return workingNomads();
    case "weworkremotely": return weWorkRemotely();
    default: throw new Error(`Unknown source ${key}`);
  }
}

// ---- helpers ----

// Some boards return a few MB (all postings at once); allow time on a cold start
const TIMEOUT_MS = 15_000;

async function get(url: string, accept: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "CareerPilot/1.0 (job search for students)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function getJson<T>(url: string): Promise<T> {
  return (await (await get(url, "application/json")).json()) as T;
}

/** RSS / XML feeds */
async function getText(url: string): Promise<string> {
  return (await get(url, "application/rss+xml, application/xml, text/xml")).text();
}

/** Only http(s) links reach the browser. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number"
    ? new Date(value < 10_000_000_000 ? value * 1000 : value) // seconds or milliseconds
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function workplace(value: unknown, remote?: boolean | null): WorkplaceType {
  const v = typeof value === "string" ? value.toLowerCase().replace(/[^a-z]/g, "") : "";
  if (v === "remote" || remote === true) return "REMOTE";
  if (v === "hybrid") return "HYBRID";
  if (v === "onsite" || v === "inoffice" || v === "office") return "ONSITE";
  return "UNSPECIFIED";
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Drops postings without a title or a safe link. The description (HTML or text) is only read for skills, not kept.
 */
function posting({ description, ...p }: Omit<RawPosting, "url" | "title" | "skills">
  & { url: unknown; title: unknown; description?: string | null }): RawPosting | null {
  const url = safeUrl(p.url);
  const title = text(p.title);
  if (!url || !title) return null;
  const skills = extractSkills(`${title}\n${p.department ?? ""}\n${description ? htmlToText(description) : ""}`);
  return { ...p, url, title: title.slice(0, 300), company: p.company.slice(0, 200), skills };
}

const notNull = <T,>(value: T | null): value is T => value !== null;

// ---- company job boards ----

type GreenhouseJob = { id: number; title: string; location?: { name?: string }; absolute_url: string; first_published?: string;
  updated_at?: string; content?: string };

/** With content=true (a few MB for big boards) so the match can read each job's requirements. */
async function greenhouse(slug: string, company: string): Promise<RawPosting[]> {
  const data = await getJson<{ jobs?: GreenhouseJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (data.jobs ?? []).map((job) => {
    const location = text(job.location?.name);
    // content is HTML with its tags escaped as entities: decoded once to HTML, then read as text
    const description = job.content ? htmlToText(job.content) : null;
    return posting({
      id: `greenhouse-${slug}-${job.id}`, title: job.title, company, location, department: null,
      // The list endpoint has no workplace field; "Remote" usually appears in the location name.
      workplaceType: location?.toLowerCase().includes("remote") ? "REMOTE" : "UNSPECIFIED",
      url: job.absolute_url, postedAt: isoDate(job.first_published ?? job.updated_at), source: "Greenhouse",
      contactEmail: emailIn(description), description,
    });
  }).filter(notNull);
}

type LeverJob = { id: string; text: string; categories?: { location?: string; team?: string; department?: string }; createdAt?: number; workplaceType?: string; hostedUrl: string; descriptionPlain?: string; lists?: { text?: string; content?: string }[] };

async function lever(slug: string, company: string): Promise<RawPosting[]> {
  const jobs = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (Array.isArray(jobs) ? jobs : []).map((job) => posting({
    id: `lever-${slug}-${job.id}`, title: job.text, company, location: text(job.categories?.location),
    department: text(job.categories?.team) ?? text(job.categories?.department), workplaceType: workplace(job.workplaceType),
    url: job.hostedUrl, postedAt: isoDate(job.createdAt), source: "Lever",
    // Requirements are often only in the bullet lists
    description: [job.descriptionPlain, ...(job.lists ?? []).map((l) => `${l.text ?? ""}\n${l.content ?? ""}`)].join("\n"),
  })).filter(notNull);
}

type AshbyJob = { id: string; title: string; department?: string; location?: string; publishedAt?: string; isListed?: boolean; isRemote?: boolean; workplaceType?: string; jobUrl: string };

async function ashby(slug: string, company: string): Promise<RawPosting[]> {
  const data = await getJson<{ jobs?: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return (data.jobs ?? []).filter((job) => job.isListed !== false).map((job) => posting({
    id: `ashby-${slug}-${job.id}`, title: job.title, company, location: text(job.location), department: text(job.department),
    workplaceType: workplace(job.workplaceType, job.isRemote), url: job.jobUrl, postedAt: isoDate(job.publishedAt), source: "Ashby",
  })).filter(notNull);
}

type SmartRecruitersJob = { id: string; name: string; releasedDate?: string; company?: { identifier?: string };
  location?: { city?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  department?: { label?: string }; function?: { label?: string } };

/** SmartRecruiters: newest 200 postings, with structured city and country. */
async function smartRecruiters(slug: string, company: string): Promise<RawPosting[]> {
  const pages = await Promise.all([0, 100].map((offset) => getJson<{ content?: SmartRecruitersJob[] }>(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100&offset=${offset}`,
  )));
  return pages.flatMap((page) => page.content ?? []).map((job) => {
    const remote = job.location?.remote === true;
    return posting({
      id: `smartrecruiters-${slug}-${job.id}`, title: job.name, company,
      location: text(job.location?.fullLocation?.replace(/,s*,/g, ",")) ?? text(job.location?.city),
      department: text(job.department?.label) ?? text(job.function?.label),
      workplaceType: remote ? "REMOTE" : job.location?.hybrid ? "HYBRID" : "UNSPECIFIED",
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(job.id)}`,
      postedAt: isoDate(job.releasedDate), source: "SmartRecruiters",
      places: [{ country: countryName(job.location?.country), city: cityName(job.location?.city), remote }],
    });
  }).filter(notNull);
}

type RecruiteeJob = { id: number; title: string; city?: string; country?: string; remote?: boolean; hybrid?: boolean;
  careers_url: string; published_at?: string; department?: string; location?: string };

/** Recruitee: all open offers, with structured city and country. */
async function recruitee(slug: string, company: string): Promise<RawPosting[]> {
  const data = await getJson<{ offers?: RecruiteeJob[] }>(`https://${slug}.recruitee.com/api/offers/`);
  return (data.offers ?? []).map((job) => posting({
    id: `recruitee-${slug}-${job.id}`, title: job.title, company,
    location: text(job.location) ?? ([job.city, job.country].filter(Boolean).join(", ") || null),
    department: text(job.department), workplaceType: job.remote ? "REMOTE" : job.hybrid ? "HYBRID" : "UNSPECIFIED",
    url: job.careers_url, postedAt: isoDate(job.published_at), source: "Recruitee",
    places: [{ country: countryName(job.country), city: cityName(job.city), remote: job.remote === true }],
  })).filter(notNull);
}

// ---- free job boards (no key) ----

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Hacker News comment HTML → plain text (tags removed, entities decoded, paragraphs as new lines). */
function htmlToText(html: string) {
  return html
    .replace(/<p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

const EMAILS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Addresses that are never a hiring contact (privacy, legal, no-reply, accessibility, placeholders). */
const NOT_HIRING = /^(no-?reply|do-?not-?reply|abuse|support|help|unsubscribe)@|(privacy|gdpr|dpo|legal|compliance|security|eeo|accommodation|ac+es+ib|ac+es+stmt|disability|ethics|whistleblow)[^@]*@|@(example|sentry)\.|\.(png|jpe?g|gif|svg|webp)$/i;

/** A word glued after a common ending ("hr@acme.com.Please apply", "jobs@acme.io.acme"): dropped. Real
 * second-level endings are short (".co.uk", ".com.au"), so 4+ letters after .com/.io/… is never part of it. */
const GLUED_WORD = /(\.(?:com|io|ai|co|org|net|dev|app|tech|in|de|jp|uk|us|eu))\.[a-z]{4,}$/i;

/** The first email in the post, including common disguises: "jobs [at] acme [dot] com", "jobs(at)acme.com". */
/** The hiring email in a posting's HTML description, if it has one. */
const emailIn = (html: string | null | undefined) => (html ? findEmail(htmlToText(html)) ?? undefined : undefined);

export function findEmail(text: string): string | null {
  const plain = text
    .replace(/\s*[[(<{]\s*at\s*[\])>}]\s*/gi, "@")
    .replace(/\s*[[(<{]\s*dot\s*[\])>}]\s*/gi, ".");
  for (const found of plain.match(EMAILS) ?? []) {
    const email = found.replace(/\.+$/, "").replace(GLUED_WORD, "$1").toLowerCase();
    if (email.length <= 254 && !NOT_HIRING.test(email)) return email;
  }
  return null;
}

const ROLE_WORDS = /engineer|developer|scientist|architect|sre|devops|programmer|swe|sde|designer|analyst|lead|cto|head of|manager|researcher|intern|founding/i;
const PLACE_WORDS = /remote|onsite|on-site|hybrid|\b[A-Z]{2}\b|,|city|york|london|berlin|bengaluru|bangalore|tokyo|india|germany|japan|usa|europe|emea|apac|worldwide/i;

type HnItem = { id: number; created_at_i?: number; text?: string | null; children?: HnItem[] };

/**
 * Hacker News "Ask HN: Who is hiring?": the latest monthly thread, one posting per top-level comment.
 * Companies write "Company | Role | Location | …" on the first line and often a hiring email in the text.
 */
async function hackerNews(): Promise<RawPosting[]> {
  const stories = await getJson<{ hits?: { objectID: string; title?: string }[] }>(
    "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10",
  );
  const thread = stories.hits?.find((hit) => /^ask hn: who is hiring\?/i.test(hit.title ?? ""));
  if (!thread) return [];
  const item = await getJson<HnItem>(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(thread.objectID)}`);
  return (item.children ?? []).map((comment) => {
    if (!comment.text) return null;
    const text = htmlToText(comment.text);
    const firstLine = text.split("\n")[0].trim();
    const parts = firstLine.split(/\s+[|—–]\s+|\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const company = parts[0].replace(/\s*\(.*?\)\s*/g, " ").trim();
    // Work-mode words aren't a role ("Company | ONSITE | City" → "Open roles")
    const role = parts.slice(1).find((part) => ROLE_WORDS.test(part))
      ?? parts.slice(1).find((part) => !/^(remote|onsite|on-site|hybrid|full[- ]?time|part[- ]?time|contract)/i.test(part) && !PLACE_WORDS.test(part))
      ?? "Open roles";
    const location = parts.slice(1).filter((part) => part !== role && PLACE_WORDS.test(part) && part.length <= 80).join(", ");
    return posting({
      id: `hackernews-${comment.id}`, title: role, company: company || "Unknown", location: location || null,
      department: firstLine.slice(0, 200),
      workplaceType: /remote/i.test(firstLine) ? "REMOTE" : /onsite|on-site/i.test(firstLine) ? "ONSITE" : /hybrid/i.test(firstLine) ? "HYBRID" : "UNSPECIFIED",
      url: `https://news.ycombinator.com/item?id=${comment.id}`, postedAt: isoDate(comment.created_at_i), source: "Hacker News",
      contactEmail: findEmail(text) ?? undefined, description: text,
    });
  }).filter(notNull);
}

type RemoteOkJob = { id?: string; slug?: string; epoch?: number; date?: string; company?: string; position?: string;
  tags?: string[]; location?: string; url?: string; apply_url?: string; description?: string };

/** Remote OK: remote jobs. Their terms: link back to the Remote OK page and name Remote OK as the source. */
async function remoteOk(): Promise<RawPosting[]> {
  const data = await getJson<RemoteOkJob[]>("https://remoteok.com/api");
  return (Array.isArray(data) ? data : []).filter((job) => job.id && job.position).map((job) => posting({
    id: `remoteok-${job.id}`, title: job.position, company: job.company ?? "Unknown",
    location: text(job.location) ?? "Remote", department: (job.tags ?? []).join(", ") || null, workplaceType: "REMOTE",
    url: job.url, postedAt: isoDate(job.date ?? job.epoch), source: "Remote OK", contactEmail: emailIn(job.description), description: job.description,
  })).filter(notNull);
}

type RemotiveJob = { id: number; url: string; title: string; company_name: string; category?: string; job_type?: string; publication_date?: string; candidate_required_location?: string; description?: string };

/** Remotive: remote software jobs. Their terms: link back to Remotive and name it as the source. */
async function remotive(): Promise<RawPosting[]> {
  const data = await getJson<{ jobs?: RemotiveJob[] }>("https://remotive.com/api/remote-jobs?category=software-dev");
  return (data.jobs ?? []).map((job) => posting({
    id: `remotive-${job.id}`, title: job.title, company: job.company_name ?? "Unknown",
    location: text(job.candidate_required_location), department: text(job.category), workplaceType: "REMOTE",
    url: job.url, postedAt: isoDate(job.publication_date), source: "Remotive", contactEmail: emailIn(job.description), description: job.description,
  })).filter(notNull);
}

type ArbeitnowJob = { slug: string; company_name: string; title: string; remote?: boolean; url: string; tags?: string[]; location?: string; created_at?: number; description?: string };

async function arbeitnow(): Promise<RawPosting[]> {
  const data = await getJson<{ data?: ArbeitnowJob[] }>("https://www.arbeitnow.com/api/job-board-api");
  return (data.data ?? []).map((job) => posting({
    id: `arbeitnow-${job.slug}`, title: job.title, company: job.company_name ?? "Unknown", location: text(job.location),
    department: (job.tags ?? []).join(", ") || null, workplaceType: job.remote ? "REMOTE" : "UNSPECIFIED",
    url: job.url, postedAt: isoDate(job.created_at), source: "Arbeitnow", contactEmail: emailIn(job.description), description: job.description,
  })).filter(notNull);
}

type MuseJob = { id: number; name: string; publication_date?: string; locations?: { name: string }[]; categories?: { name: string }[]; refs?: { landing_page?: string }; company?: { name?: string }; contents?: string };

/** The Muse: software engineering jobs, newest first (5 pages of 20). */
async function theMuse(): Promise<RawPosting[]> {
  const pages = await Promise.all([0, 1, 2, 3, 4].map((page) => getJson<{ results?: MuseJob[] }>(
    `https://www.themuse.com/api/public/jobs?category=Software%20Engineering&page=${page}`,
  )));
  return pages.flatMap((data) => data.results ?? []).map((job) => {
    const location = (job.locations ?? []).map((l) => l.name).join("; ") || null;
    return posting({
      id: `themuse-${job.id}`, title: job.name, company: job.company?.name ?? "Unknown", location,
      department: (job.categories ?? []).map((c) => c.name).join(", ") || null,
      workplaceType: location?.toLowerCase().includes("remote") ? "REMOTE" : "UNSPECIFIED",
      url: job.refs?.landing_page, postedAt: isoDate(job.publication_date), source: "The Muse", contactEmail: emailIn(job.contents), description: job.contents,
    });
  }).filter(notNull);
}

type HimalayasJob = { title: string; companyName: string; locationRestrictions?: string[]; categories?: string[]; parentCategories?: string[]; pubDate?: number; applicationLink?: string; guid?: string; description?: string };

/** Himalayas: remote jobs feed (cursor paging, 5 pages). */
async function himalayas(): Promise<RawPosting[]> {
  const jobs: HimalayasJob[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const data = await getJson<{ jobs?: HimalayasJob[]; nextCursor?: string }>(
      `https://himalayas.app/jobs/api?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    jobs.push(...(data.jobs ?? []));
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return jobs.map((job) => posting({
    id: `himalayas-${job.guid ?? job.applicationLink}`, title: job.title, company: job.companyName ?? "Unknown",
    location: (job.locationRestrictions ?? []).join(", ") || "Remote",
    // The main category only ("Developer"); the long tag list stays out of the cards
    department: (job.parentCategories ?? []).join(", ") || null,
    workplaceType: "REMOTE", url: job.applicationLink ?? job.guid, postedAt: isoDate(job.pubDate), source: "Himalayas", contactEmail: emailIn(job.description), description: job.description,
  })).filter(notNull);
}

type JobicyJob = { id: number; url: string; jobTitle: string; companyName?: string; jobIndustry?: string[]; jobGeo?: string; pubDate?: string; jobDescription?: string };

/** Jobicy: remote engineering jobs (up to 100). Their terms: credit Jobicy and link to the original posting. */
async function jobicy(): Promise<RawPosting[]> {
  const data = await getJson<{ jobs?: JobicyJob[] }>("https://jobicy.com/api/v2/remote-jobs?count=100&industry=engineering");
  return (data.jobs ?? []).map((job) => posting({
    id: `jobicy-${job.id}`, title: job.jobTitle, company: job.companyName ?? "Unknown",
    // jobGeo is where applicants may live ("Anywhere", "India", "EMEA")
    location: text(job.jobGeo) ?? "Remote", department: (job.jobIndustry ?? []).join(", ") || null,
    workplaceType: "REMOTE", url: job.url, postedAt: isoDate(job.pubDate), source: "Jobicy", contactEmail: emailIn(job.jobDescription), description: job.jobDescription,
  })).filter(notNull);
}

type WorkingNomadsJob = { url: string; title: string; company_name?: string; category_name?: string; tags?: string; location?: string; pub_date?: string; description?: string };

/** Working Nomads: latest remote jobs; only the Development category is kept. */
async function workingNomads(): Promise<RawPosting[]> {
  const jobs = await getJson<WorkingNomadsJob[]>("https://www.workingnomads.com/api/exposed_jobs/");
  return (Array.isArray(jobs) ? jobs : []).filter((job) => job.category_name === "Development").map((job) => posting({
    id: `workingnomads-${job.url.replace(/\D+/g, "") || job.url}`, title: job.title, company: job.company_name ?? "Unknown",
    location: text(job.location) ?? "Remote", department: text(job.tags), workplaceType: "REMOTE",
    url: job.url, postedAt: isoDate(job.pub_date), source: "Working Nomads", contactEmail: emailIn(job.description), description: job.description,
  })).filter(notNull);
}

/** The text inside the first <tag>…</tag> of an RSS item (CDATA unwrapped, entities decoded). */
function rssField(item: string, tag: string) {
  const raw = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? "";
  return htmlToText(raw.replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim();
}

/** We Work Remotely: remote programming jobs (RSS). Titles are "Company: Role". Their terms: link back to WWR. */
async function weWorkRemotely(): Promise<RawPosting[]> {
  const feeds = await Promise.all(["remote-back-end-programming-jobs", "remote-front-end-programming-jobs",
    "remote-full-stack-programming-jobs", "remote-devops-sysadmin-jobs"].map((category) =>
    getText(`https://weworkremotely.com/categories/${category}.rss`)));
  return feeds.flatMap((xml) => xml.split("<item>").slice(1)).map((item) => {
    const heading = rssField(item, "title");
    const split = heading.indexOf(": ");
    const url = rssField(item, "link");
    return posting({
      id: `weworkremotely-${url.split("/").pop() ?? url}`,
      title: split > 0 ? heading.slice(split + 2) : heading,
      company: split > 0 ? heading.slice(0, split) : "Unknown",
      location: rssField(item, "region") || "Remote", department: rssField(item, "category") || null,
      workplaceType: "REMOTE", url, postedAt: isoDate(rssField(item, "pubDate")), source: "We Work Remotely",
      // The description is HTML escaped inside the RSS, so it's decoded twice
      contactEmail: emailIn(htmlToText(rssField(item, "description"))), description: htmlToText(rssField(item, "description")),
    });
  }).filter(notNull);
}
