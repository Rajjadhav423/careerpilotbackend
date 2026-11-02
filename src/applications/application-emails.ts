import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth/clerk.js";
import type { Db } from "../db/prisma.js";
import type { GmailService, SentMessage } from "../gmail/gmail.js";
import type { MimeAttachment } from "../gmail/mime.js";
import { ApiError } from "../http/errors.js";
import { body, uuidParam } from "../http/validate.js";
import type { Job, JobService, JobStatus } from "../jobs/jobs.js";
import { MERGE_FIELDS, placeholder, remainingPlaceholders, resolve } from "../templates/merge-fields.js";
import type { TemplateService } from "../templates/templates.js";
import type { User } from "../users/users.js";
import {
  newTrackingToken, pixelUrl, readThread, RECHECK_AFTER_MS, TRACK_FOR_MS, trackingStatus,
  type DeliveryStatus, type TrackingStatus,
} from "./email-tracking.js";
import { followUpsDue, type FollowUp } from "./follow-ups.js";

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
  /** Your own subject instead of the template's; {{placeholders}} in it are filled like a template's */
  subject: z.string().max(255, "size must be between 0 and 255").regex(/^[^\r\n]*$/, "must be a single line").nullish(),
  /** Your own body instead of the template's; {{placeholders}} in it are filled like a template's */
  body: z.string().max(20_000, "size must be between 0 and 20000").nullish(),
});

/** Text that replaces the template's when composing (blank or absent keeps the template's). */
export type ComposeOverrides = { subject?: string | null; body?: string | null };

/** confirmed must be true: the user reviewed the email and explicitly chose to send it. */
export const sendSchema = z.object({
  to: notBlank(254).pipe(z.string().regex(EMAIL_ADDRESS, "must be a single valid email address")),
  subject: notBlank(255).pipe(z.string().regex(/^[^\r\n]*$/, "must be a single line")),
  body: notBlank(20_000),
  templateId: uuid.nullish(),
  /** One of the user's saved resumes, attached as a PDF */
  resumeId: uuid.nullish(),
  /** One of the user's CareerPilot PDFs in Google Drive, attached as is (e.g. the resume linked in the email) */
  driveDocumentId: uuid.nullish(),
  /** A follow-up: one of this job's sent emails; the new email goes into its Gmail thread */
  replyToId: uuid.nullish(),
  confirmed: z.boolean().nullish(),
});

export type SendRequest = z.infer<typeof sendSchema>;

/** An email checked and ready for Gmail (see ApplicationEmailService.prepare). */
export type PreparedEmail = {
  jobId: string;
  templateId: string | null;
  to: string;
  subject: string;
  body: string;
  attachment?: MimeAttachment;
  /** A follow-up: the email whose Gmail thread it goes into */
  replyTo?: { gmailMessageId: string; gmailThreadId: string | null };
  trackingToken: string | null;
  /** Open-tracking image URL, when tracking is on */
  pixel?: string;
};

/** A saved resume as a PDF attachment. */
export type ResumePdf = (user: User, resumeId: string) => Promise<MimeAttachment>;

/** Gmail's API accepts messages up to about 5 MB when sent inline; base64 adds a third. */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

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
  /** The headline status: REPLIED, BOUNCED, OPENED, DELIVERED or SENT */
  status: TrackingStatus;
  deliveryStatus: DeliveryStatus;
  bouncedAt: Date | null;
  /** False when open tracking was off for this email (so "not opened" means nothing) */
  openTracked: boolean;
  openCount: number;
  firstOpenedAt: Date | null;
  lastOpenedAt: Date | null;
  replyCount: number;
  repliedAt: Date | null;
  /** Last time the Gmail thread was checked for bounces and replies; null = never (no permission yet) */
  checkedAt: Date | null;
};

/** A sent email with the job it was for (the list across all jobs). */
export type SentEmailWithJob = SentEmailResponse & { job: { id: string; title: string; company: string } | null };

const TRACKED_FIELDS = {
  id: true, recipient: true, subject: true, templateId: true, sentAt: true, gmailMessageId: true, gmailThreadId: true,
  deliveryStatus: true, bouncedAt: true, trackingToken: true, openCount: true, firstOpenedAt: true, lastOpenedAt: true,
  replyCount: true, repliedAt: true, checkedAt: true,
} as const;

type TrackedRow = {
  id: string; recipient: string; subject: string; templateId: string | null; sentAt: Date;
  gmailMessageId: string; gmailThreadId: string | null; deliveryStatus: string; bouncedAt: Date | null;
  trackingToken: string | null; openCount: number; firstOpenedAt: Date | null; lastOpenedAt: Date | null;
  replyCount: number; repliedAt: Date | null; checkedAt: Date | null;
};

/** Gmail threads checked per request at most, so a long list can't make the request slow. */
const MAX_CHECKS_PER_REQUEST = 10;

function toResponse(row: TrackedRow): SentEmailResponse {
  return {
    id: row.id, recipient: row.recipient, subject: row.subject, templateId: row.templateId, sentAt: row.sentAt,
    status: trackingStatus(row),
    deliveryStatus: row.deliveryStatus as DeliveryStatus, bouncedAt: row.bouncedAt,
    openTracked: row.trackingToken !== null, openCount: row.openCount,
    firstOpenedAt: row.firstOpenedAt, lastOpenedAt: row.lastOpenedAt,
    replyCount: row.replyCount, repliedAt: row.repliedAt, checkedAt: row.checkedAt,
  };
}

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
    /** Renders one of the user's saved resumes as a PDF; throws 404 for anyone else's */
    private readonly resumePdf?: ResumePdf,
    /** Downloads one of the user's CareerPilot PDFs from Drive; throws 404 for anyone else's */
    private readonly drivePdf?: ResumePdf,
    /** Public URL of this API; when set, sent emails carry an open-tracking pixel */
    private readonly trackingBaseUrl: string | null = null,
  ) {}

  /**
   * The template filled in for this job. overrides: the user's own subject and/or body replace the template's
   * (placeholders in them are filled the same way); without a template, only the overrides are used.
   */
  async compose(
    user: User, jobId: string, templateId: string | null | undefined, timeZone: string | null | undefined,
    overrides: ComposeOverrides = {},
  ): Promise<ComposeResponse> {
    const job = await this.jobs.get(user.id, jobId);
    const template = templateId
      ? await this.templates.get(user.id, templateId)
      : await this.templates.findDefault(user.id);
    const ownSubject = overrides.subject?.trim() ? overrides.subject : null;
    const ownBody = overrides.body?.trim() ? overrides.body : null;
    if (!template && ownSubject === null && ownBody === null) {
      return { templateId: null, templateName: null, subject: "", body: "", missingFields: [], unknownPlaceholders: [] };
    }
    // Saved details (Settings) fill anything the account and job don't have, e.g. {{resume_url}} or {{github}}
    const builtIn = mergeValues(user, job, timeZone, this.now());
    const details = await this.templates.detailValues(user.id);
    const values: Record<string, string | null> = { ...details };
    for (const [key, value] of Object.entries(builtIn)) if (value != null && value.trim() !== "") values[key] = value;
    const subject = resolve(ownSubject ?? template?.subject ?? "", values);
    const text = resolve(ownBody ?? template?.body ?? "", values);
    const missing = new Set([...subject.missing, ...text.missing]);
    return {
      templateId: template?.id ?? null,
      templateName: template?.name ?? null,
      subject: subject.text,
      body: text.text,
      missingFields: MERGE_FIELDS.filter((field) => missing.has(field.key))
        .map((field) => ({ key: field.key, placeholder: placeholder(field.key), label: field.label })),
      unknownPlaceholders: [...new Set([...subject.unknown, ...text.unknown])],
    };
  }

  async send(user: User, jobId: string, request: SendRequest): Promise<SendResponse> {
    const email = await this.prepare(user, jobId, request);
    // Talks to Gmail outside any database transaction; nothing is recorded unless Gmail accepts the message
    const sent = await this.gmail.send(user, email.to, email.subject, email.body, email.attachment, email.pixel, email.replyTo);
    return this.record(user.id, email, sent, this.now());
  }

  /**
   * Everything checked and built before an email goes to Gmail, now or as a scheduled draft: the user confirmed it,
   * owns the job (and template and follow-up), no placeholders are left, and the attachment is rendered.
   */
  async prepare(user: User, jobId: string, request: SendRequest): Promise<PreparedEmail> {
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

    const to = request.to.trim();
    const subject = request.subject.trim();
    // Rendered on the server from the user's own saved resume: nothing uploaded from the browser is attached
    const attachment = request.driveDocumentId
      ? await this.attachment(user, request.driveDocumentId, this.drivePdf)
      : request.resumeId ? await this.attachment(user, request.resumeId, this.resumePdf) : undefined;
    const replyTo = request.replyToId
      ? await this.db.sentEmail.findFirst({
        where: { id: request.replyToId, userId: user.id, jobId: job.id },
        select: { gmailMessageId: true, gmailThreadId: true },
      })
      : undefined;
    if (replyTo === null) throw new ApiError(404, "EMAIL_NOT_FOUND", "The email you're following up on wasn't found.");
    const trackingToken = this.trackingBaseUrl ? newTrackingToken() : null;
    const pixel = trackingToken ? pixelUrl(this.trackingBaseUrl!, trackingToken) : undefined;
    return { jobId: job.id, templateId, to, subject, body: request.body, attachment, replyTo: replyTo ?? undefined, trackingToken, pixel };
  }

  /** Saves an email Gmail accepted and marks its job Applied, in one transaction. */
  async record(
    userId: string,
    email: Pick<PreparedEmail, "jobId" | "templateId" | "to" | "subject" | "trackingToken">,
    sent: SentMessage,
    sentAt: Date,
  ): Promise<SendResponse> {
    return this.db.$transaction(async (tx) => {
      const record = await tx.sentEmail.create({ data: {
        userId, jobId: email.jobId, templateId: email.templateId, recipient: email.to, subject: email.subject,
        gmailMessageId: sent.messageId, gmailThreadId: sent.threadId, sentAt, trackingToken: email.trackingToken,
      } });
      const updated = await this.jobs.recordApplicationSent(userId, email.jobId, sentAt, tx);
      return { id: record.id, sentAt, jobStatus: updated.status, appliedAt: updated.appliedAt };
    });
  }

  private async attachment(user: User, id: string, load: ResumePdf | undefined): Promise<MimeAttachment> {
    if (!load) throw new ApiError(503, "ATTACHMENTS_UNAVAILABLE", "Attaching a resume isn't available right now.");
    const pdf = await load(user, id);
    if (pdf.content.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new ApiError(422, "ATTACHMENT_TOO_LARGE", "The resume PDF is too large to attach. Send its Drive link instead.");
    }
    return pdf;
  }

  /** Emails Gmail accepted for this job, newest first, with up-to-date tracking. */
  async history(user: User, jobId: string): Promise<SentEmailResponse[]> {
    const job = await this.jobs.get(user.id, jobId);
    const rows = await this.db.sentEmail.findMany({
      where: { userId: user.id, jobId: job.id },
      orderBy: { sentAt: "desc" },
      select: TRACKED_FIELDS,
    });
    return (await this.refresh(user, rows)).map(toResponse);
  }

  /** All of the user's sent emails, newest first, with the job each was for. */
  async list(user: User, limit = 100): Promise<SentEmailWithJob[]> {
    const rows = await this.db.sentEmail.findMany({
      where: { userId: user.id },
      orderBy: { sentAt: "desc" },
      take: limit,
      select: { ...TRACKED_FIELDS, job: { select: { id: true, title: true, company: true } } },
    });
    const refreshed = await this.refresh(user, rows);
    return refreshed.map((row) => ({ ...toResponse(row), job: row.job }));
  }

  /** Applied jobs waiting on the user (see follow-ups.ts); their Gmail threads are checked for new replies first. */
  async followUps(user: User): Promise<FollowUp[]> {
    const jobs = await this.db.job.findMany({
      where: { userId: user.id, status: "APPLIED", archived: false },
      select: { id: true, title: true, company: true, updatedAt: true, sentEmails: { select: TRACKED_FIELDS } },
    });
    const refreshed = new Map((await this.refresh(user, jobs.flatMap((job) => job.sentEmails))).map((row) => [row.id, row]));
    return followUpsDue(jobs.map(({ sentEmails, ...job }) => ({
      ...job, emails: sentEmails.map((row) => toResponse(refreshed.get(row.id) ?? row)),
    })), this.now());
  }

  /** Tracking for a few of the user's emails only (the rows a page still watches); unknown ids are left out. */
  async statuses(user: User, ids: string[]): Promise<SentEmailResponse[]> {
    const rows = await this.db.sentEmail.findMany({
      where: { userId: user.id, id: { in: ids } },
      orderBy: { sentAt: "desc" },
      select: TRACKED_FIELDS,
    });
    return (await this.refresh(user, rows)).map(toResponse);
  }

  /**
   * Reads the Gmail thread of emails not checked recently (newest first, a few per request) for bounces and replies.
   * Best effort: without the gmail.metadata permission, or when Gmail is down, the stored status is returned as is.
   */
  private async refresh<T extends TrackedRow>(user: User, rows: T[]): Promise<T[]> {
    const now = this.now();
    const due = rows.filter((row) => row.gmailThreadId
      && row.deliveryStatus !== "BOUNCED"
      && now.getTime() - row.sentAt.getTime() < TRACK_FOR_MS
      && (!row.checkedAt || now.getTime() - row.checkedAt.getTime() >= RECHECK_AFTER_MS))
      .slice(0, MAX_CHECKS_PER_REQUEST);
    if (due.length === 0) return rows;

    const updated = new Map<string, T>();
    await Promise.all(due.map(async (row) => {
      try {
        const messages = await this.gmail.threadMessages(user, row.gmailThreadId!);
        if (messages === null) return;
        const findings = readThread(messages, row, now);
        await this.db.sentEmail.update({ where: { id: row.id }, data: { ...findings, checkedAt: now } });
        updated.set(row.id, { ...row, ...findings, checkedAt: now });
      } catch (error) {
        // Name only: the stored tracking is still correct, just not refreshed
        console.warn(`Couldn't refresh email tracking: ${(error as Error).name}`);
      }
    }));
    return rows.map((row) => updated.get(row.id) ?? row);
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
    res.json(await service.compose(currentUser(res), jobId, request.templateId, request.timeZone,
      { subject: request.subject, body: request.body }));
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

/** Mounted at /api/v1/emails: every application email the user sent, with tracking. */
export function sentEmailsRouter(service: ApplicationEmailService): Router {
  const router = Router();
  /** ?ids=a,b,c (up to 20): fresh tracking for just those rows, so a page can poll without reloading the list. */
  router.get("/status", async (req, res) => {
    const raw = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = z.array(uuid).min(1).max(20).safeParse(raw.split(",").map((id) => id.trim()).filter(Boolean));
    if (!ids.success) throw new ApiError(400, "VALIDATION_FAILED", "ids must be 1 to 20 email ids, comma-separated");
    res.json(await service.statuses(currentUser(res), [...new Set(ids.data)]));
  });
  router.get("/", async (_req, res) => {
    res.json(await service.list(currentUser(res)));
  });
  return router;
}
