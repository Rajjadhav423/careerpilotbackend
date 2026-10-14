import { Router } from "express";

import { ApiError } from "../http/errors.js";
import { flag, query } from "../http/validate.js";
import { boardLabel, PROVIDERS, type BoardFetcher, type BoardProvider, type JobBoard, type JobPosting } from "./boards.js";
import { classify, TECH_ROLES, type TechRole } from "./classify.js";

/*
 * Fetches all configured job boards in parallel, keeps only tech jobs, caches the merged result and searches it.
 * One failing board never breaks the others; its error is reported in `sources`.
 */

export const MAX_LIMIT = 500;
export const CACHE_TTL_MS = 15 * 60 * 1000;

/** count: tech jobs kept from this board (non-tech postings are dropped) */
export type SourceStatus = {
  board: string;
  company: string;
  provider: string;
  ok: boolean;
  count: number;
  error: string | null;
};

export type DiscoverResponse = {
  /** Matching postings, newest first, at most `limit` */
  jobs: JobPosting[];
  /** Number of matches before the limit was applied */
  total: number;
  /** Matches per tech role for the current query and location (ignoring the role filter) */
  roleCounts: Partial<Record<TechRole, number>>;
  /** When the boards were last fetched (results are cached) */
  fetchedAt: Date;
  sources: SourceStatus[];
};

type Snapshot = { jobs: JobPosting[]; sources: SourceStatus[]; fetchedAt: Date };

const normalise = (text: string | null | undefined) => (text ?? "").toLowerCase().trim();

export class DiscoveryService {
  private snapshot: Snapshot | null = null;
  /** Concurrent searches share one fetch instead of each hitting every board */
  private inFlight: Promise<Snapshot> | null = null;

  constructor(
    private readonly boards: JobBoard[],
    private readonly fetchers: Partial<Record<BoardProvider, BoardFetcher>>,
    private readonly cacheTtlMs = CACHE_TTL_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** role: only this kind of tech job, or null for all tech jobs. */
  async search(q: string, location: string, role: TechRole | null, limit: number, refresh: boolean)
    : Promise<DiscoverResponse> {
    const current = await this.currentSnapshot(refresh);
    const terms = normalise(q).split(/\s+/).filter(Boolean);
    const place = normalise(location);

    const queryMatches = current.jobs.filter((job) => matchesTerms(job, terms) && matchesLocation(job, place));
    const roleCounts: Partial<Record<TechRole, number>> = {};
    for (const job of queryMatches) {
      if (job.techRole) roleCounts[job.techRole] = (roleCounts[job.techRole] ?? 0) + 1;
    }
    const matches = role ? queryMatches.filter((job) => job.techRole === role) : queryMatches;
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_LIMIT);
    return {
      jobs: matches.slice(0, safeLimit),
      total: matches.length,
      roleCounts,
      fetchedAt: current.fetchedAt,
      sources: current.sources,
    };
  }

  private async currentSnapshot(refresh: boolean): Promise<Snapshot> {
    const now = this.now();
    const fresh = this.snapshot && this.snapshot.fetchedAt.getTime() + this.cacheTtlMs >= now.getTime();
    if (!refresh && fresh) return this.snapshot!;
    if (!this.inFlight) {
      this.inFlight = this.fetchAll(now).finally(() => {
        this.inFlight = null;
      });
    }
    this.snapshot = await this.inFlight;
    return this.snapshot;
  }

  private async fetchAll(now: Date): Promise<Snapshot> {
    const results = await Promise.all(this.boards.map((board) => this.fetchBoard(board)));
    const jobs = results.flatMap((result) => result.jobs);
    // Newest first; postings without a date last
    jobs.sort((a, b) => (b.postedAt?.getTime() ?? -Infinity) - (a.postedAt?.getTime() ?? -Infinity));
    console.info(`Fetched ${jobs.length} tech job postings from ${this.boards.length} boards`);
    return { jobs, sources: results.map((result) => result.status), fetchedAt: now };
  }

  private async fetchBoard(board: JobBoard): Promise<{ jobs: JobPosting[]; status: SourceStatus }> {
    const provider = PROVIDERS[board.provider];
    const failed = (error: string) => ({
      jobs: [],
      status: { board: boardLabel(board), company: board.companyName, provider, ok: false, count: 0, error },
    });
    const fetcher = this.fetchers[board.provider];
    if (!fetcher) return failed(`No client for provider ${provider}`);
    try {
      const jobs: JobPosting[] = [];
      for (const posting of await fetcher(board)) {
        // Non-tech postings are dropped
        const techRole = classify(posting.title, posting.department);
        if (techRole) jobs.push({ ...posting, techRole });
      }
      return {
        jobs,
        status: { board: boardLabel(board), company: board.companyName, provider, ok: true, count: jobs.length, error: null },
      };
    } catch (error) {
      console.warn(`Could not fetch job board ${boardLabel(board)}: ${(error as Error).message}`);
      return failed("Could not fetch this board right now.");
    }
  }
}

function matchesTerms(job: JobPosting, terms: string[]) {
  if (terms.length === 0) return true;
  const haystack = normalise(`${job.title} ${job.company} ${job.department}`);
  return terms.every((term) => haystack.includes(term));
}

function matchesLocation(job: JobPosting, place: string) {
  if (!place) return true;
  if (place === "remote" && job.workplaceType === "REMOTE") return true;
  return normalise(job.location).includes(place);
}

export function discoveryRouter(discovery: DiscoveryService): Router {
  const router = Router();

  /** Example: GET /api/v1/discover/jobs?q=java&location=bengaluru&role=BACKEND */
  router.get("/jobs", async (req, res) => {
    const rawRole = query(req, "role");
    let role: TechRole | null = null;
    if (rawRole) {
      if (!(TECH_ROLES as readonly string[]).includes(rawRole)) {
        throw new ApiError(400, "VALIDATION_FAILED", `role must be one of ${TECH_ROLES.join(", ")}`);
      }
      role = rawRole as TechRole;
    }
    const rawLimit = query(req, "limit");
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit)) throw new ApiError(400, "VALIDATION_FAILED", "limit must be a whole number");
    res.json(await discovery.search(query(req, "q") ?? "", query(req, "location") ?? "", role, limit,
      flag(req, "refresh")));
  });

  return router;
}
