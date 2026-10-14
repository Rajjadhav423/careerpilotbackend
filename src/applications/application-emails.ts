import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth/clerk.js";
import type { Db } from "../db/prisma.js";
import type { GmailService } from "../gmail/gmail.js";
import { ApiError } from "../http/errors.js";
import { body, uuidParam } from "../http/validate.js";
import type { Job, JobService, JobStatus } from "../jobs/jobs.js";
import { MERGE_FIELDS, placeholder, remainingPlaceholders, resolve } from "../templates/merge-fields.js";
import type { TemplateService } from "../templates/templates.js";
import type { User } from "../users/users.js";

/*
 * Application emails for one of the user's jobs: compose from a template, then send through the user's Gmail after
 * explicit confirmation. The job is updated only after Gmail accepts the message.
 */

/** One plain address, e.g. hiring@company.com. No display names, lists or line breaks. */
const EMAIL_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}$/;

const uuid = z.string().uuid("must be a valid id");
const notBlank = (max: number) =>
  z.string({ required_error: "must not be blank", invalid_type_error: "must not be blank" })
    .max(max, `size must be between 0 and ${max}`)
    .refine((value) => value.trim() !== "", "must not be blank");

/**
 * templateId: omitted = the user's default template (or a blank email if none).
 * timeZone: the browser's IANA time zone, used to format {{application_date}}.
 */
export const composeSchema = z.object({
  templateId: uuid.nullish(),
  timeZone: z.string().max(64, "size must be between 0 and 64").nullish(),
});

/** confirmed must be true: the user reviewed the email and explicitly chose to send it. */
export const sendSchema = z.object({
  to: notBlank(254).pipe(z.string().regex(EMAIL_ADDRESS, "must be a single valid email address")),
  subject: notBlank(255).pipe(z.string().regex(/^[^\r\n]*$/, "must be a single line")),
  body: notBlank(20_000),
  templateId: uuid.nullish(),
  confirmed: z.boolean().nullish(),
});

export type SendRequest = z.infer<typeof sendSchema>;

export type ComposeResponse = {
  templateId: string | null;
  templateName: string | null;
  subject: string;
  body: string;
  missingFields: { key: string; placeholder: string; label: string }[];
  unknownPlaceholders: string[];
};

export type SendResponse = { id: string; sentAt: Date; jobStatus: JobStatus; appliedAt: Date | null };

export type SentEmailResponse = {
  id: string;
  recipient: string;
  subject: string;
  templateId: string | null;
  sentAt: Date;
};

/** "11 October 2026" in the given IANA zone; unknown or blank zones fall back to UTC. */
export function formatApplicationDate(date: Date, timeZone: string | null | undefined): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: zone }).format(date);
  if (!timeZone?.trim()) return format("UTC");
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

/** Only real data; a missing value stays null so the placeholder is flagged, never invented. */
export function mergeValues(user: User, job: Job, timeZone: string | null | undefined, now: Date) {
  return {
    candidate_name: user.displayName,
    candidate_email: user.email,
    resume_url: null, // no resume library link yet
    job_title: job.title,
    company_name: job.company,
    job_location: job.location,
    job_url: job.jobUrl,
    application_url: job.jobUrl, // one link per job: "where you found it or apply"
    application_date: formatApplicationDate(job.appliedAt ?? now, timeZone),
  };
}

export class ApplicationEmailService {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobService,
    private readonly templates: TemplateService,
    private readonly gmail: GmailService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async compose(user: User, jobId: string, templateId: string | null | undefined, timeZone: string | null | undefined)
    : Promise<ComposeResponse> {
    const job = await this.jobs.get(user.id, jobId);
    const template = templateId
      ? await this.templates.get(user.id, templateId)
      : await this.templates.findDefault(user.id);
    if (!template) {
      return { templateId: null, templateName: null, subject: "", body: "", missingFields: [], unknownPlaceholders: [] };
    }
    const values = mergeValues(user, job, timeZone, this.now());
    const subject = resolve(template.subject, values);
    const text = resolve(template.body, values);
    const missing = new Set([...subject.missing, ...text.missing]);
    return {
      templateId: template.id,
      templateName: template.name,
      subject: subject.text,
      body: text.text,
      missingFields: MERGE_FIELDS.filter((field) => missing.has(field.key))
        .map((field) => ({ key: field.key, placeholder: placeholder(field.key), label: field.label })),
      unknownPlaceholders: [...new Set([...subject.unknown, ...text.unknown])],
    };
  }

  async send(user: User, jobId: string, request: SendRequest): Promise<SendResponse> {
    if (!request.confirmed) {
      throw new ApiError(400, "CONFIRMATION_REQUIRED", "Review the email and confirm before sending.");
    }
    const job = await this.jobs.get(user.id, jobId);
    const templateId = request.templateId ? (await this.templates.get(user.id, request.templateId)).id : null;

    const unresolved = [...new Set([...remainingPlaceholders(request.subject), ...remainingPlaceholders(request.body)])];
    if (unresolved.length > 0) {
      throw new ApiError(422, "UNRESOLVED_PLACEHOLDERS",
        `Replace these placeholders before sending: ${unresolved.join(", ")}`);
    }

    // Talks to Gmail outside any database transaction; nothing is recorded unless Gmail accepts the message
    const to = request.to.trim();
    const subject = request.subject.trim();
    const sent = await this.gmail.send(user, to, subject, request.body);
    const sentAt = this.now();

    return this.db.$transaction(async (tx) => {
      const record = await tx.sentEmail.create({ data: {
        userId: user.id, jobId: job.id, templateId, recipient: to, subject,
        gmailMessageId: sent.messageId, gmailThreadId: sent.threadId, sentAt,
      } });
      const updated = await this.jobs.recordApplicationSent(user.id, job.id, sentAt, tx);
      return { id: record.id, sentAt, jobStatus: updated.status, appliedAt: updated.appliedAt };
    });
  }

  /** Emails Gmail accepted for this job, newest first. */
  async history(user: User, jobId: string): Promise<SentEmailResponse[]> {
    const job = await this.jobs.get(user.id, jobId);
    return this.db.sentEmail.findMany({
      where: { userId: user.id, jobId: job.id },
      orderBy: { sentAt: "desc" },
      select: { id: true, recipient: true, subject: true, templateId: true, sentAt: true },
    });
  }
}

const jobNotFound = () => new ApiError(404, "JOB_NOT_FOUND", "Job not found.");

/** Mounted at /api/v1/jobs/:jobId/emails. */
export function applicationEmailsRouter(service: ApplicationEmailService): Router {
  const router = Router({ mergeParams: true });

  /** Fills a template with this job's details for editing. Sends nothing and saves nothing. */
  router.post("/compose", async (req, res) => {
    const jobId = uuidParam(req, "jobId", jobNotFound());
    const request = body(req, composeSchema);
    res.json(await service.compose(currentUser(res), jobId, request.templateId, request.timeZone));
  });

  /** Sends the reviewed email from the user's Gmail. Requires "confirmed": true. */
  router.post("/", async (req, res) => {
    const jobId = uuidParam(req, "jobId", jobNotFound());
    res.json(await service.send(currentUser(res), jobId, body(req, sendSchema)));
  });

  router.get("/", async (req, res) => {
    res.json(await service.history(currentUser(res), uuidParam(req, "jobId", jobNotFound())));
  });

  return router;
}
