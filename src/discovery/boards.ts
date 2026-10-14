import type { TechRole } from "./classify.js";

/* Public company job boards (Greenhouse, Lever, Ashby) and their clients. No API keys needed. */

export const PROVIDERS = { GREENHOUSE: "Greenhouse", LEVER: "Lever", ASHBY: "Ashby" } as const;
export type BoardProvider = keyof typeof PROVIDERS;

export type WorkplaceType = "ONSITE" | "HYBRID" | "REMOTE" | "UNSPECIFIED";

/** One company's public job board, configured as "provider:slug:Company Name", e.g. "greenhouse:groww:Groww". */
export type JobBoard = { provider: BoardProvider; slug: string; companyName: string };

/**
 * A job opening found on a public job board, normalised to one shape for all providers.
 * Not stored: it becomes a tracked job only when the user saves it.
 */
export type JobPosting = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  department: string | null;
  workplaceType: WorkplaceType;
  url: string | null;
  postedAt: Date | null;
  source: string;
  /** Set by the discovery service; clients leave it null */
  techRole: TechRole | null;
};

export const DEFAULT_BOARDS = [
  "greenhouse:groww:Groww",
  "greenhouse:druva:Druva",
  "greenhouse:hackerrank:HackerRank",
  "greenhouse:stripe:Stripe",
  "greenhouse:databricks:Databricks",
  "greenhouse:cloudflare:Cloudflare",
  "lever:cred:CRED",
  "lever:meesho:Meesho",
  "lever:zeta:Zeta",
  "lever:paytm:Paytm",
  "ashby:sarvam:Sarvam AI",
  "ashby:notion:Notion",
  "ashby:openai:OpenAI",
];

/** Board slugs are plain identifiers; anything else (slashes, dots, hosts) is rejected at startup. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export function parseBoard(value: string): JobBoard {
  const trimmed = value.trim();
  const first = trimmed.indexOf(":");
  const second = first < 0 ? -1 : trimmed.indexOf(":", first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`Invalid job board '${value}'. Expected format provider:slug:Company Name`);
  }
  const providerText = trimmed.slice(0, first).trim().toUpperCase();
  const slug = trimmed.slice(first + 1, second).trim();
  const companyName = trimmed.slice(second + 1).trim();
  if (!slug || !companyName) {
    throw new Error(`Invalid job board '${value}'. Expected format provider:slug:Company Name`);
  }
  if (!(providerText in PROVIDERS)) {
    throw new Error(`Unknown job board provider '${trimmed.slice(0, first)}' in '${value}'`);
  }
  if (!SLUG.test(slug)) {
    throw new Error(`Invalid job board slug '${slug}' in '${value}'. Use letters, digits, '-' or '_' only`);
  }
  return { provider: providerText as BoardProvider, slug, companyName };
}

/** Short label used in logs and API responses, e.g. "Groww (Greenhouse)". */
export const boardLabel = (board: JobBoard) => `${board.companyName} (${PROVIDERS[board.provider]})`;

/** Normalises provider values such as "onsite", "OnSite", "on-site", "Remote". */
export function workplaceFrom(value: string | null | undefined): WorkplaceType {
  switch ((value ?? "").toLowerCase().replace(/[^a-z]/g, "")) {
    case "onsite":
    case "inoffice":
    case "office":
      return "ONSITE";
    case "hybrid":
      return "HYBRID";
    case "remote":
      return "REMOTE";
    default:
      return "UNSPECIFIED";
  }
}

/** ISO-8601 with offset (e.g. "2026-09-14T03:49:28-04:00"); null when missing or malformed. */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type BoardFetcher = (board: JobBoard) => Promise<JobPosting[]>;

/** Reads JSON, never following redirects (outbound calls must only reach the intended host). */
async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** https://developers.greenhouse.io/job-board.html */
export function greenhouseFetcher(fetchImpl: typeof fetch = fetch): BoardFetcher {
  return async (board) => {
    const body = (await getJson(fetchImpl, `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs`)) as {
      jobs?: { id: number | string; title: string; location?: { name?: string } | null; absolute_url?: string;
        first_published?: string; updated_at?: string }[];
    } | null;
    return (body?.jobs ?? []).map((job): JobPosting => {
      const location = job.location?.name ?? null;
      return {
        id: `greenhouse-${board.slug}-${job.id}`,
        title: job.title,
        company: board.companyName,
        location,
        department: null,
        // The list endpoint has no workplace field; "Remote" usually appears in the location name
        workplaceType: location?.toLowerCase().includes("remote") ? "REMOTE" : "UNSPECIFIED",
        url: job.absolute_url ?? null,
        postedAt: parseTimestamp(job.first_published ?? job.updated_at),
        source: PROVIDERS.GREENHOUSE,
        techRole: null,
      };
    });
  };
}

/** https://github.com/lever/postings-api */
export function leverFetcher(fetchImpl: typeof fetch = fetch): BoardFetcher {
  return async (board) => {
    const jobs = (await getJson(fetchImpl, `https://api.lever.co/v0/postings/${board.slug}?mode=json`)) as {
      id: string; text: string; categories?: { location?: string; team?: string; department?: string } | null;
      createdAt?: number; workplaceType?: string; hostedUrl?: string;
    }[] | null;
    return (Array.isArray(jobs) ? jobs : []).map((job): JobPosting => {
      const categories = job.categories ?? {};
      return {
        id: `lever-${board.slug}-${job.id}`,
        title: job.text,
        company: board.companyName,
        location: categories.location ?? null,
        department: categories.team ?? categories.department ?? null,
        workplaceType: workplaceFrom(job.workplaceType),
        url: job.hostedUrl ?? null,
        postedAt: typeof job.createdAt === "number" ? new Date(job.createdAt) : null,
        source: PROVIDERS.LEVER,
        techRole: null,
      };
    });
  };
}

/** https://developers.ashbyhq.com/docs/public-job-posting-api */
export function ashbyFetcher(fetchImpl: typeof fetch = fetch): BoardFetcher {
  return async (board) => {
    const body = (await getJson(fetchImpl, `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`)) as {
      jobs?: { id: string; title: string; department?: string; location?: string; publishedAt?: string;
        isListed?: boolean; isRemote?: boolean; workplaceType?: string; jobUrl?: string }[];
    } | null;
    return (body?.jobs ?? [])
      .filter((job) => job.isListed !== false)
      .map((job): JobPosting => {
        let workplace = workplaceFrom(job.workplaceType);
        if (workplace === "UNSPECIFIED" && job.isRemote === true) workplace = "REMOTE";
        return {
          id: `ashby-${board.slug}-${job.id}`,
          title: job.title,
          company: board.companyName,
          location: job.location ?? null,
          department: job.department ?? null,
          workplaceType: workplace,
          url: job.jobUrl ?? null,
          postedAt: parseTimestamp(job.publishedAt),
          source: PROVIDERS.ASHBY,
          techRole: null,
        };
      });
  };
}

export const defaultFetchers = (fetchImpl: typeof fetch = fetch): Record<BoardProvider, BoardFetcher> => ({
  GREENHOUSE: greenhouseFetcher(fetchImpl),
  LEVER: leverFetcher(fetchImpl),
  ASHBY: ashbyFetcher(fetchImpl),
});
