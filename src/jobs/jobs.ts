import type { Job as JobModel } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth/clerk.js";
import type { Db, Tx } from "../db/prisma.js";
import { ApiError } from "../http/errors.js";
import { body, flag, httpUrlOrEmpty, optionalText, query, requiredText, uuidParam } from "../http/validate.js";
import { importJobFromUrl } from "./import-from-url.js";

/* The signed-in user's job board. Every query takes the owner's id; other users' jobs behave as missing (404). */

/** Board columns, in order. Same ids as the frontend's lib/jobs/statuses.ts. */
export const JOB_STATUSES = ["SAVED", "TO_REVIEW", "PREPARING", "APPLIED", "INTERVIEW", "OFFER", "REJECTED", "CLOSED"] as const;
export const WORK_MODES = ["ONSITE", "HYBRID", "REMOTE"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type WorkMode = (typeof WORK_MODES)[number];

export const MANUAL_SOURCE = "MANUAL";

/** Statuses that move to APPLIED when an application email is sent; later stages are never moved back. */
const BEFORE_APPLIED: ReadonlySet<JobStatus> = new Set(["SAVED", "TO_REVIEW", "PREPARING"]);

export type Job = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  workMode: WorkMode | null;
  jobUrl: string | null;
  description: string | null;
  notes: string | null;
  status: JobStatus;
  archived: boolean;
  source: string;
  externalId: string | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The API shape (no owner id). */
const toJob = ({ userId: _owner, ...job }: JobModel): Job => ({
  ...job,
  workMode: job.workMode as WorkMode | null,
  status: job.status as JobStatus,
});

const status = z.enum(JOB_STATUSES, { message: `must be one of ${JOB_STATUSES.join(", ")}` });
const workMode = z.enum(WORK_MODES, { message: `must be one of ${WORK_MODES.join(", ")}` });

/**
 * Add a job. source/externalId are set when saving a posting from Find jobs; saving the same externalId again
 * returns the existing job.
 */
export const createJobSchema = z.object({
  title: requiredText(200),
  company: requiredText(200),
  location: optionalText(200),
  workMode: workMode.nullish(),
  jobUrl: httpUrlOrEmpty(2048),
  description: optionalText(20_000),
  notes: optionalText(10_000),
  status: status.nullish(),
  source: optionalText(32),
  externalId: optionalText(200),
});

/** Partial update: absent (null) fields stay; an empty string clears optional text. Title/company can't be cleared. */
export const updateJobSchema = z.object({
  title: z.string().min(1, "size must be between 1 and 200").max(200, "size must be between 1 and 200").nullish(),
  company: z.string().min(1, "size must be between 1 and 200").max(200, "size must be between 1 and 200").nullish(),
  location: optionalText(200),
  workMode: workMode.nullish(),
  jobUrl: httpUrlOrEmpty(2048),
  description: optionalText(20_000),
  notes: optionalText(10_000),
  status: status.nullish(),
  archived: z.boolean().nullish(),
});

export type CreateJobRequest = z.infer<typeof createJobSchema>;
export type UpdateJobRequest = z.infer<typeof updateJobSchema>;

const blankToNull = (value: string | null | undefined) => (value == null || value.trim() === "" ? null : value.trim());

const notFound = () => new ApiError(404, "JOB_NOT_FOUND", "Job not found.");

export class JobService {
  constructor(private readonly db: Db) {}

  async list(userId: string, filter: { status?: JobStatus; archived: boolean }): Promise<Job[]> {
    const jobs = await this.db.job.findMany({
      where: { userId, archived: filter.archived, ...(filter.status ? { status: filter.status } : {}) },
      orderBy: { updatedAt: "desc" },
    });
    return jobs.map(toJob);
  }

  get(userId: string, jobId: string, tx: Tx = this.db): Promise<Job> {
    return findJob(tx, userId, jobId).then(toJob);
  }

  /** created=false when this posting was already saved (the existing job is returned). */
  async create(userId: string, request: CreateJobRequest): Promise<{ job: Job; created: boolean }> {
    const externalId = blankToNull(request.externalId);
    if (externalId) {
      const existing = await this.db.job.findFirst({ where: { userId, externalId } });
      if (existing) return { job: toJob(existing), created: false };
    }
    const source = !externalId || !request.source?.trim() ? MANUAL_SOURCE : request.source.trim().toUpperCase();
    const job = await this.db.job.create({
      data: {
        userId,
        title: request.title.trim(),
        company: request.company.trim(),
        location: blankToNull(request.location),
        workMode: request.workMode ?? null,
        jobUrl: blankToNull(request.jobUrl),
        description: blankToNull(request.description),
        notes: blankToNull(request.notes),
        status: request.status ?? "SAVED",
        source,
        externalId,
      },
    });
    return { job: toJob(job), created: true };
  }

  async update(userId: string, jobId: string, request: UpdateJobRequest): Promise<Job> {
    const data: Record<string, unknown> = {};
    if (request.title != null) data.title = requireText(request.title, "title");
    if (request.company != null) data.company = requireText(request.company, "company");
    if (request.location != null) data.location = blankToNull(request.location);
    if (request.workMode != null) data.workMode = request.workMode;
    if (request.jobUrl != null) data.jobUrl = blankToNull(request.jobUrl);
    if (request.description != null) data.description = blankToNull(request.description);
    if (request.notes != null) data.notes = blankToNull(request.notes);
    if (request.status != null) data.status = request.status;
    if (request.archived != null) data.archived = request.archived;
    const job = await findJob(this.db, userId, jobId);
    if (Object.keys(data).length === 0) return toJob(job);
    return toJob(await this.db.job.update({ where: { id: job.id }, data }));
  }

  /** Called only after Gmail accepted an application email for this job. appliedAt keeps the first send. */
  async recordApplicationSent(userId: string, jobId: string, sentAt: Date, tx: Tx = this.db): Promise<Job> {
    const job = await findJob(tx, userId, jobId);
    return toJob(await tx.job.update({
      where: { id: job.id },
      data: {
        status: BEFORE_APPLIED.has(job.status as JobStatus) ? "APPLIED" : job.status,
        appliedAt: job.appliedAt ?? sentAt,
      },
    }));
  }
}

async function findJob(tx: Tx, userId: string, jobId: string) {
  const job = await tx.job.findFirst({ where: { id: jobId, userId } });
  if (!job) throw notFound();
  return job;
}

function requireText(value: string, field: string) {
  if (value.trim() === "") throw new ApiError(400, "VALIDATION_FAILED", `${field} must not be blank`);
  return value.trim();
}

export function jobsRouter(jobs: JobService): Router {
  const router = Router();

  /** Active jobs, newest change first. ?archived=true lists archived ones instead. */
  router.get("/", async (req, res) => {
    const rawStatus = query(req, "status");
    const parsed = rawStatus === undefined || rawStatus === "" ? undefined : status.safeParse(rawStatus);
    if (parsed && !parsed.success) {
      throw new ApiError(400, "VALIDATION_FAILED", `status must be one of ${JOB_STATUSES.join(", ")}`);
    }
    const list = await jobs.list(currentUser(res).id, { status: parsed?.data, archived: flag(req, "archived") });
    res.json(list);
  });

  /** 201 for a new job; 200 with the existing job when this posting (externalId) was saved before. */
  router.post("/", async (req, res) => {
    const result = await jobs.create(currentUser(res).id, body(req, createJobSchema));
    if (result.created) res.status(201).location(`/api/v1/jobs/${result.job.id}`);
    res.json(result.job);
  });

  /** Reads a job posting from a link ({ "url": "https://…" }) without saving it. */
  router.post("/import-from-url", async (req, res) => {
    currentUser(res);
    const { url } = body(req, z.object({ url: z.string().max(2048, "size must be between 0 and 2048") }));
    res.json(await importJobFromUrl(url));
  });

  router.get("/:id", async (req, res) => {
    res.json(await jobs.get(currentUser(res).id, uuidParam(req, "id", notFound())));
  });

  /** Edit fields, move to another status, or archive ("archived": true). */
  router.patch("/:id", async (req, res) => {
    const id = uuidParam(req, "id", notFound());
    res.json(await jobs.update(currentUser(res).id, id, body(req, updateJobSchema)));
  });

  return router;
}
