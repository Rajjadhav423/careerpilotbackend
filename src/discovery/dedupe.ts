import type { JobPosting, SourceKind } from "./sources.js";

/*
 * The same opening often appears on several sources (the company's own board, a job board and an aggregator).
 * Postings are merged when they have the same link, or the same company and title in a compatible location.
 * The kept posting is the most direct one (company board > job board > aggregator), then the newest; the
 * others are listed in `alsoOn`.
 */

export type Classified = JobPosting & { kind: SourceKind };

const KIND_RANK: Record<SourceKind, number> = { company: 0, feed: 1, aggregator: 2 };

const COMPANY_SUFFIXES = /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|company|gmbh|plc|technologies|technology|tech|labs|software|solutions|systems|india|global|group|the)\b/g;

function normalise(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ") // "(m/w/d)", "[Remote]"
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function companyKey(company: string) {
  return normalise(company).replace(COMPANY_SUFFIXES, " ").replace(/\s+/g, "").trim();
}

const TITLE_WORDS: [RegExp, string][] = [
  [/\bsr\b/g, "senior"], [/\bjr\b/g, "junior"], [/\bsw\b/g, "software"], [/\bengg?\b/g, "engineer"],
  [/\bdev\b/g, "developer"], [/\bmgr\b/g, "manager"],
];

export function titleKey(title: string) {
  let key = normalise(title);
  for (const [pattern, replacement] of TITLE_WORDS) key = key.replace(pattern, replacement);
  return key.replace(/\b(remote|hybrid|onsite|on site|full time|fulltime|contract|m w d|f m d)\b/g, " ").replace(/\s+/g, " ").trim();
}

const CITY_ALIASES: Record<string, string> = {
  bangalore: "bengaluru", bengaluru: "bengaluru", gurgaon: "gurugram", gurugram: "gurugram",
  bombay: "mumbai", mumbai: "mumbai", madras: "chennai", chennai: "chennai", "new delhi": "delhi", delhi: "delhi",
  calcutta: "kolkata", kolkata: "kolkata", poona: "pune", pune: "pune",
};

/** First place of a location ("Bengaluru, Karnataka, India" → "bengaluru"); "" when unknown or remote. */
export function cityKey(location: string | null) {
  const first = normalise((location ?? "").split(/[,;/|]/)[0]);
  if (!first || /^(remote|anywhere|worldwide|global)$/.test(first)) return "";
  return CITY_ALIASES[first] ?? first;
}

/** Tracking parameters that don't change which job a link points to. */
const TRACKING = /^(utm_.*|ref|referrer|source|src|gh_src|lever-source|lever-origin|fbclid|gclid)$/i;

/**
 * Host + path + meaningful query. The query matters: some boards put the job id there
 * (e.g. Greenhouse's "…/job?gh_jid=123"), so dropping it would merge different jobs.
 */
function canonicalUrl(url: string) {
  try {
    const parsed = new URL(url);
    const query = [...parsed.searchParams.entries()]
      .filter(([name]) => !TRACKING.test(name))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const base = `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
    return query ? `${base}?${query}` : base;
  } catch {
    return url.toLowerCase();
  }
}

function better(a: Classified, b: Classified) {
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (rank !== 0) return rank < 0;
  return (a.postedAt ?? "") >= (b.postedAt ?? "");
}

/** Merges duplicates; the result keeps the input order of the kept postings. */
export function dedupe(postings: Classified[]): JobPosting[] {
  const kept: Classified[] = [];
  const alsoOn = new Map<Classified, Set<string>>();
  const byUrl = new Map<string, Classified>();
  const byCompanyTitle = new Map<string, Classified[]>();

  const replace = (existing: Classified, incoming: Classified) => {
    const sources = alsoOn.get(existing) ?? new Set<string>();
    if (better(incoming, existing)) {
      sources.add(existing.source);
      sources.delete(incoming.source);
      kept[kept.indexOf(existing)] = incoming;
      alsoOn.delete(existing);
      alsoOn.set(incoming, sources);
      return incoming;
    }
    if (incoming.source !== existing.source) sources.add(incoming.source);
    alsoOn.set(existing, sources);
    return existing;
  };

  for (const posting of postings) {
    const urlKey = canonicalUrl(posting.url);
    const groupKey = `${companyKey(posting.company)}|${titleKey(posting.title)}`;
    const city = cityKey(posting.location);

    let match = byUrl.get(urlKey);
    if (!match) {
      // Same company and title: the same job if the cities agree (or one side doesn't say)
      match = (byCompanyTitle.get(groupKey) ?? []).find((other) => {
        const otherCity = cityKey(other.location);
        return city === otherCity || city === "" || otherCity === "";
      });
    }

    if (!match) {
      kept.push(posting);
      byUrl.set(urlKey, posting);
      byCompanyTitle.set(groupKey, [...(byCompanyTitle.get(groupKey) ?? []), posting]);
      continue;
    }

    const winner = replace(match, posting);
    if (winner !== match) {
      // Re-point the indexes at the new kept posting
      for (const [key, value] of byUrl) if (value === match) byUrl.set(key, winner);
      byCompanyTitle.set(groupKey, (byCompanyTitle.get(groupKey) ?? []).map((value) => (value === match ? winner : value)));
    }
    byUrl.set(urlKey, winner);
  }

  return kept.map((posting) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- internal field, not sent to the browser
    const { kind, ...rest } = posting;
    const others = [...(alsoOn.get(posting) ?? [])];
    return others.length ? { ...rest, alsoOn: others } : rest;
  });
}
