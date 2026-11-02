import { Router } from "express";

import { ApiError } from "../http/errors.js";
import { currentUser } from "../auth/clerk.js";
import { flag, query, UUID } from "../http/validate.js";
import { classify, TECH_ROLES, type TechRole } from "./classify.js";
import { dedupe, type Classified } from "./dedupe.js";
import { parsePlaces } from "./places.js";
import { matchSkills, type Match } from "./skills.js";
import { freshMs, type JobPosting, type JobSources, type RawPosting } from "./sources.js";

/*
 * Find jobs: every ready source (each cached on its own, shared by all users), tech jobs only, duplicates merged,
 * newest first; the user's search is then applied in memory. A failing source never breaks the others.
 */

export const MAX_LIMIT = 500;
/** "Refresh" re-fetches the free sources at most this often */
const REFRESH_INTERVAL_MS = 60_000;

export type SourceStatus = { board: string; company: string; provider: string; ok: boolean; count: number; error: string | null };
export type Facet = { name: string; count: number };

/** A posting with its match to the chosen resume (null: the post names no known skill) */
export type MatchedPosting = JobPosting & { match?: Match | null };

export type DiscoverResponse = {
  /** Matching postings, newest first (best resume match first when matching), at most `limit` */
  jobs: MatchedPosting[];
  /** Skills read from the chosen resume; null when not matching against a resume */
  resumeSkills: string[] | null;
  /** Number of matches before the limit was applied */
  total: number;
  /** Matches per role for the current query and place, ignoring the role filter */
  roleCounts: Partial<Record<TechRole, number>>;
  /** Countries (and cities of the chosen country) with job counts, for the location filters */
  /** withEmail: matches (ignoring the email filter) whose post gives a hiring email */
  facets: { countries: Facet[]; cities: Facet[]; remote: number; withEmail: number };
  /** When the oldest source in this result was fetched */
  fetchedAt: string;
  sources: SourceStatus[];
};

export type DiscoverQuery = {
  q: string;
  /** Free text matched against the location (older clients) */
  location: string;
  /** Country display name, e.g. "India" */
  country: string | null;
  /** City in that country, e.g. "Bengaluru" */
  city: string | null;
  /** Remote jobs only */
  remote: boolean;
  /** Posted on or after (inclusive) / before (exclusive); jobs without a date are left out when set */
  from: Date | null;
  to: Date | null;
  role: TechRole | null;
  /** Only postings that give a hiring email */
  hasEmail: boolean;
  /** Skills of the resume to match against; results are then sorted by match */
  resumeSkills: string[] | null;
  limit: number;
};

type CacheEntry = { result: Promise<{ postings: RawPosting[]; fetchedAt: string }>; fresh: number; expires: number };
type AllJobs = { jobs: JobPosting[]; sources: SourceStatus[]; fetchedAt: string };

export class JobSearch {
  private readonly cache = new Map<string, CacheEntry>();
  private lastRefresh = 0;

  constructor(private readonly sources: JobSources, private readonly now: () => Date = () => new Date()) {}

  async search(query: DiscoverQuery, refresh = false): Promise<DiscoverResponse> {
    if (refresh) this.refreshSources();
    return search(await this.allJobs(), query);
  }

  /** Forgets the cached sources so the next search re-fetches them (at most once a minute). */
  private refreshSources() {
    const now = this.now().getTime();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;
    this.cache.clear();
  }

  /**
   * A source's postings: cached while fresh; after that it's re-fetched in the background while the old copy is
   * still served (until it fully expires). Failures aren't kept, so the next search tries again. Concurrent
   * searches share one fetch.
   */
  private postings(key: string) {
    const now = this.now().getTime();
    const entry = this.cache.get(key);
    if (entry && now < entry.fresh) return entry.result;
    const ttl = freshMs(key);
    const next = this.sources.load(key).then((postings) => ({ postings, fetchedAt: this.now().toISOString() }));
    const stored: CacheEntry = { result: next, fresh: now + ttl, expires: now + ttl * 4 };
    next.then(
      () => this.cache.set(key, stored),
      (error: Error) => {
        console.warn(`Could not fetch job source ${key}: ${error.message}`);
        if (this.cache.get(key) === stored) this.cache.delete(key);
      },
    );
    if (entry && now < entry.expires) {
      // Serve the previous copy now; the new one replaces it when it arrives
      entry.fresh = now + 60_000;
      return entry.result;
    }
    this.cache.set(key, stored);
    return next;
  }

  /** All tech postings from every ready source, merged. */
  private async allJobs(): Promise<AllJobs> {
    const ready = this.sources.list();
    const results = await Promise.allSettled(ready.map((source) => this.postings(source.key)));

    const classified: Classified[] = [];
    const statuses: SourceStatus[] = [];
    let oldest: string | null = null;

    results.forEach((result, index) => {
      const source = ready[index]!;
      const status = { board: source.board, company: source.company, provider: source.provider };
      if (result.status === "rejected") {
        statuses.push({ ...status, ok: false, count: 0, error: "Could not fetch this source right now." });
        return;
      }
      let count = 0;
      for (const raw of result.value.postings) {
        const techRole = classify(raw.title, raw.department);
        if (!techRole) continue;
        const places = raw.places?.length ? raw.places : parsePlaces(raw.location);
        const remote = raw.workplaceType === "REMOTE" || places.some((p) => p.remote);
        classified.push({
          ...raw,
          places: remote && !places.some((p) => p.remote) ? [...places, { country: null, city: null, remote: true }] : places,
          workplaceType: remote ? "REMOTE" : raw.workplaceType,
          techRole,
          kind: source.kind,
        });
        count++;
      }
      statuses.push({ ...status, ok: true, count, error: null });
      if (!oldest || result.value.fetchedAt < oldest) oldest = result.value.fetchedAt;
    });

    classified.sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
    return { jobs: dedupe(classified) as JobPosting[], sources: statuses, fetchedAt: oldest ?? this.now().toISOString() };
  }
}

const normalise = (value: string) => value.toLowerCase().trim();

function isRemote(job: JobPosting) {
  return job.workplaceType === "REMOTE" || job.places.some((p) => p.remote);
}

function matchesPosted(job: JobPosting, query: DiscoverQuery) {
  if (!query.from && !query.to) return true;
  if (!job.postedAt) return false;
  const posted = Date.parse(job.postedAt);
  return (!query.from || posted >= query.from.getTime()) && (!query.to || posted < query.to.getTime());
}

function matchesPlace(job: JobPosting, query: DiscoverQuery) {
  if (query.remote && !isRemote(job)) return false;
  if (query.country) {
    const inCountry = job.places.some((p) => p.country === query.country && (!query.city || p.city === query.city));
    if (!inCountry) return false;
  }
  const place = normalise(query.location);
  if (!place) return true;
  if (place === "remote") return isRemote(job);
  return normalise(job.location ?? "").includes(place);
}

/** Counts per name, most first. */
function tally(names: Iterable<string>): Facet[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function search(all: AllJobs, query: DiscoverQuery): DiscoverResponse {
  const terms = normalise(query.q).split(/\s+/).filter(Boolean);
  const textMatches = all.jobs.filter((job) => {
    const haystack = normalise(`${job.title} ${job.company} ${job.department ?? ""}`);
    return terms.every((term) => haystack.includes(term)) && matchesPosted(job, query);
  });

  // Role chips count jobs in the chosen place; country/city lists count jobs of the chosen role
  const inPlace = textMatches.filter((job) => matchesPlace(job, query));
  const withEmail = inPlace.filter((job) => (!query.role || job.techRole === query.role) && job.contactEmail).length;
  const placeMatches = query.hasEmail ? inPlace.filter((job) => job.contactEmail) : inPlace;
  const roleCounts: Partial<Record<TechRole, number>> = {};
  for (const job of placeMatches) roleCounts[job.techRole] = (roleCounts[job.techRole] ?? 0) + 1;

  const forFacets = textMatches.filter((job) => (!query.role || job.techRole === query.role) && (!query.remote || isRemote(job))
    && (!query.hasEmail || job.contactEmail));
  const countries = tally(forFacets.flatMap((job) => [...new Set(job.places.map((p) => p.country).filter((c): c is string => !!c))]));
  const cities = query.country
    ? tally(forFacets.flatMap((job) => [...new Set(job.places.filter((p) => p.country === query.country && p.city).map((p) => p.city as string))]))
    : [];

  const matches = query.role ? placeMatches.filter((job) => job.techRole === query.role) : placeMatches;
  const limit = Math.min(Math.max(Math.trunc(query.limit) || 1, 1), MAX_LIMIT);
  return {
    jobs: query.resumeSkills ? byMatch(matches, new Set(query.resumeSkills)).slice(0, limit) : matches.slice(0, limit),
    resumeSkills: query.resumeSkills,
    total: matches.length,
    roleCounts,
    facets: { countries, cities, remote: forFacets.filter(isRemote).length, withEmail },
    fetchedAt: all.fetchedAt,
    sources: all.sources,
  };
}

/** Best match first; then more matched skills; posts without known skills last; newest first within ties. */
function byMatch(jobs: JobPosting[], resumeSkills: Set<string>): MatchedPosting[] {
  return jobs
    .map((job) => ({ ...job, match: matchSkills(job.skills, resumeSkills) }))
    .sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1)
      || (b.match?.matched.length ?? 0) - (a.match?.matched.length ?? 0)
      || (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
}

/** The skills found in one of the user's resumes; throws 404 for a resume they don't own. */
export type ResumeSkills = (userId: string, resumeId: string) => Promise<string[]>;

const PRESET_HOURS: Record<string, number> = { "24h": 24, "3d": 72, "7d": 168, "30d": 720 };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (message: string) => new ApiError(400, "VALIDATION_FAILED", message);

/** posted=24h|3d|7d|30d, or from/to as YYYY-MM-DD (UTC days, both inclusive). */
function postedRange(posted: string | undefined, fromText: string, toText: string, now: Date) {
  if (posted) {
    const hours = PRESET_HOURS[posted];
    if (!hours) throw invalid("posted must be 24h, 3d, 7d or 30d");
    return { from: new Date(now.getTime() - hours * 3_600_000), to: null };
  }
  if ((fromText && !DAY.test(fromText)) || (toText && !DAY.test(toText))) throw invalid("Dates must be YYYY-MM-DD");
  const from = fromText ? new Date(`${fromText}T00:00:00Z`) : null;
  // "to" includes that whole day
  const to = toText ? new Date(Date.parse(`${toText}T00:00:00Z`) + 86_400_000) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw invalid("That date doesn't exist");
  if (from && to && from >= to) throw invalid("The start date must be on or before the end date");
  return { from, to };
}

export function jobSearchRouter(jobSearch: JobSearch, resumeSkills: ResumeSkills, now: () => Date = () => new Date()): Router {
  const router = Router();

  /** Example: GET /api/v1/discover/jobs?q=java&country=India&city=Bengaluru&remote=false&role=BACKEND&posted=7d */
  router.get("/jobs", async (req, res) => {
    const rawRole = query(req, "role");
    if (rawRole && !(TECH_ROLES as readonly string[]).includes(rawRole)) {
      throw invalid(`role must be one of ${TECH_ROLES.join(", ")}`);
    }
    const rawLimit = query(req, "limit");
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit)) throw invalid("limit must be a whole number");
    const country = (query(req, "country") ?? "").trim().slice(0, 60) || null;
    const resumeId = query(req, "resumeId");
    if (resumeId && !UUID.test(resumeId)) throw invalid("resumeId must be a resume id");
    const skills = resumeId ? await resumeSkills(currentUser(res).id, resumeId.toLowerCase()) : null;
    const range = postedRange(query(req, "posted"), query(req, "from") ?? "", query(req, "to") ?? "", now());
    res.set("Cache-Control", "private, no-store");
    res.json(await jobSearch.search({
      q: (query(req, "q") ?? "").slice(0, 200),
      location: (query(req, "location") ?? "").slice(0, 100),
      country,
      city: country ? (query(req, "city") ?? "").trim().slice(0, 80) || null : null,
      remote: flag(req, "remote"),
      from: range.from,
      to: range.to,
      role: (rawRole as TechRole | undefined) ?? null,
      hasEmail: flag(req, "hasEmail"),
      resumeSkills: skills,
      limit,
    }, flag(req, "refresh")));
  });

  return router;
}
