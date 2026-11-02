import { timingSafeEqual } from "node:crypto";

import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth/clerk.js";
import type { Db } from "../db/prisma.js";
import type { GmailService } from "../gmail/gmail.js";
import { ApiError } from "../http/errors.js";
import { body, uuidParam } from "../http/validate.js";
import type { User } from "../users/users.js";
import { sendSchema, type ApplicationEmailService } from "./application-emails.js";

/*
 * Scheduled application emails. Gmail's API can't use Gmail's own "Schedule send", so each scheduled email is saved
 * as a real draft in the user's Gmail (they can see it in Drafts, and edits made there are what gets sent) and the
 * run endpoint sends due drafts. An outside pinger (e.g. cron-job.org) calls the run endpoint every few minutes with
 * SCHEDULER_SECRET.
 *
 * Statuses: SCHEDULED → SENDING (claimed by one run, so a draft is never sent twice) → SENT, or FAILED (shown to the
 * user, never retried silently), or CANCELLED (the draft is deleted).
 */

export type ScheduledStatus = "SCHEDULED" | "SENDING" | "SENT" | "FAILED" | "CANCELLED";

export type ScheduledEmailResponse = {
  id: string;
  recipient: string;
  subject: string;
  sendAt: Date;
  status: ScheduledStatus;
  /** Why it failed, when status is FAILED */
  error: string | null;
  /** The sent email once sent (its tracking is under /emails) */
  sentEmailId: string | null;
  createdAt: Date;
  job: { id: string; title: string; company: string };
};

/** At least this far ahead, so the email isn't due before it's saved */
export const MIN_LEAD_MS = 60_000;
/** At most this far ahead */
export const MAX_AHEAD_MS = 365 * 24 * 60 * 60_000;
/** Emails sent per run at most (each run is one short serverless request) */
export const MAX_PER_RUN = 20;
/** A SENDING row this old was interrupted mid-send (crash or timeout) */
export const STUCK_AFTER_MS = 10 * 60_000;

export const scheduleSchema = sendSchema.extend({
  /** When to send, ISO 8601 with a time zone, e.g. 2026-11-03T09:00:00+05:30 */
  sendAt: z.string().datetime({ offset: true, message: "must be a date and time with a time zone" }),
});

export const rescheduleSchema = z.object({
  sendAt: z.string().datetime({ offset: true, message: "must be a date and time with a time zone" }),
});

const SELECT = {
  id: true, recipient: true, subject: true, sendAt: true, status: true, error: true, sentEmailId: true, createdAt: true,
  job: { select: { id: true, title: true, company: true } },
} as const;

const notFound = () => new ApiError(404, "SCHEDULED_EMAIL_NOT_FOUND", "Scheduled email not found.");
const notScheduled = () => new ApiError(409, "NOT_SCHEDULED", "This email has already been sent or cancelled.");

function toResponse(row: {
  id: string; recipient: string; subject: string; sendAt: Date; status: string; error: string | null;
  sentEmailId: string | null; createdAt: Date; job: { id: string; title: string; company: string };
}): ScheduledEmailResponse {
  return { ...row, status: row.status as ScheduledStatus };
}

/** A failure message the user can act on; never the raw exception text. */
const failureMessage = (error: unknown) =>
  error instanceof ApiError ? error.message.slice(0, 500) : "Gmail couldn't send it. Check your Sent folder, then schedule it again.";

export class ScheduledEmailService {
  constructor(
    private readonly db: Db,
    private readonly emails: ApplicationEmailService,
    private readonly gmail: GmailService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private sendAt(value: string): Date {
    const sendAt = new Date(value);
    const ahead = sendAt.getTime() - this.now().getTime();
    if (ahead < MIN_LEAD_MS) throw new ApiError(400, "VALIDATION_FAILED", "Pick a time at least a minute from now.");
    if (ahead > MAX_AHEAD_MS) throw new ApiError(400, "VALIDATION_FAILED", "Pick a time within the next year.");
    return sendAt;
  }

  /** Checks the email like an immediate send, saves it as a draft in the user's Gmail and schedules it. */
  async schedule(user: User, jobId: string, request: z.infer<typeof scheduleSchema>): Promise<ScheduledEmailResponse> {
    const sendAt = this.sendAt(request.sendAt);
    const email = await this.emails.prepare(user, jobId, request);
    const { draftId } = await this.gmail.createDraft(
      user, email.to, email.subject, email.body, email.attachment, email.pixel, email.replyTo);
    const row = await this.db.scheduledEmail.create({
      data: {
        userId: user.id, jobId: email.jobId, templateId: email.templateId, recipient: email.to, subject: email.subject,
        gmailDraftId: draftId, sendAt, trackingToken: email.trackingToken,
      },
      select: SELECT,
    });
    return toResponse(row);
  }

  /** The user's scheduled emails: waiting or failed first (soonest first), then the latest 50 sent or cancelled. */
  async list(user: User): Promise<ScheduledEmailResponse[]> {
    const [open, closed] = await Promise.all([
      this.db.scheduledEmail.findMany({
        where: { userId: user.id, status: { in: ["SCHEDULED", "SENDING", "FAILED"] } }, orderBy: { sendAt: "asc" }, select: SELECT,
      }),
      this.db.scheduledEmail.findMany({
        where: { userId: user.id, status: { in: ["SENT", "CANCELLED"] } }, orderBy: { sendAt: "desc" }, take: 50, select: SELECT,
      }),
    ]);
    return [...open, ...closed].map(toResponse);
  }

  private async owned(user: User, id: string) {
    const row = await this.db.scheduledEmail.findFirst({ where: { id, userId: user.id } });
    if (!row) throw notFound();
    return row;
  }

  async reschedule(user: User, id: string, value: string): Promise<ScheduledEmailResponse> {
    const sendAt = this.sendAt(value);
    await this.owned(user, id);
    const { count } = await this.db.scheduledEmail.updateMany({ where: { id, status: "SCHEDULED" }, data: { sendAt } });
    if (count === 0) throw notScheduled();
    return toResponse(await this.db.scheduledEmail.findUniqueOrThrow({ where: { id }, select: SELECT }));
  }

  /** Cancels it and deletes its draft from the user's Gmail. */
  async cancel(user: User, id: string): Promise<ScheduledEmailResponse> {
    const row = await this.owned(user, id);
    const { count } = await this.db.scheduledEmail.updateMany({ where: { id, status: { in: ["SCHEDULED", "FAILED"] } }, data: { status: "CANCELLED" } });
    if (count === 0) throw notScheduled();
    try {
      await this.gmail.deleteDraft(user, row.gmailDraftId);
    } catch (error) {
      // Cancelled either way: it will never be sent. The draft may stay in Gmail for the user to delete.
      console.warn(`Couldn't delete a cancelled email's draft: ${(error as Error).name}`);
    }
    return toResponse(await this.db.scheduledEmail.findUniqueOrThrow({ where: { id }, select: SELECT }));
  }

  /** Sends a waiting email right away. */
  async sendNow(user: User, id: string): Promise<ScheduledEmailResponse> {
    await this.owned(user, id);
    if (!(await this.claim(id))) throw notScheduled();
    await this.deliver(id, user);
    return toResponse(await this.db.scheduledEmail.findUniqueOrThrow({ where: { id }, select: SELECT }));
  }

  /** SCHEDULED → SENDING for exactly one caller, so two runs (or a run and "Send now") never send it twice. */
  private async claim(id: string): Promise<boolean> {
    const { count } = await this.db.scheduledEmail.updateMany({ where: { id, status: "SCHEDULED" }, data: { status: "SENDING" } });
    return count === 1;
  }

  /** Sends a claimed email's draft and records the result. Never throws: a failure is saved on the row. */
  private async deliver(id: string, user: User): Promise<void> {
    const row = await this.db.scheduledEmail.findUniqueOrThrow({ where: { id } });
    try {
      const sent = await this.gmail.sendDraft(user, row.gmailDraftId);
      if (!sent) {
        await this.db.scheduledEmail.update({ where: { id }, data: {
          status: "FAILED", error: "The draft was deleted in Gmail, so nothing was sent.",
        } });
        return;
      }
      const sentAt = this.now();
      const record = await this.emails.record(user.id, {
        jobId: row.jobId, templateId: row.templateId, to: row.recipient, subject: row.subject, trackingToken: row.trackingToken,
      }, sent, sentAt);
      await this.db.scheduledEmail.update({ where: { id }, data: { status: "SENT", sentEmailId: record.id, error: null } });
    } catch (error) {
      console.warn(`Scheduled email failed: ${(error as Error).name}`);
      await this.db.scheduledEmail.update({ where: { id }, data: { status: "FAILED", error: failureMessage(error) } });
    }
  }

  /** Sends every due email (up to MAX_PER_RUN) and marks interrupted sends as failed. Called by the pinger. */
  async runDue(): Promise<{ sent: number; failed: number; remaining: number }> {
    const now = this.now();
    // Interrupted mid-send: it may or may not have gone out, so the user checks instead of a risky resend
    await this.db.scheduledEmail.updateMany({
      where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
      data: { status: "FAILED", error: "Sending was interrupted. Check your Gmail Sent folder before scheduling it again." },
    });

    const due = await this.db.scheduledEmail.findMany({
      where: { status: "SCHEDULED", sendAt: { lte: now } }, orderBy: { sendAt: "asc" }, take: MAX_PER_RUN,
      select: { id: true, user: true },
    });
    let sent = 0;
    let failed = 0;
    for (const { id, user } of due) {
      if (!(await this.claim(id))) continue;
      await this.deliver(id, user);
      const { status } = await this.db.scheduledEmail.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (status === "SENT") sent++;
      else failed++;
    }
    const remaining = await this.db.scheduledEmail.count({ where: { status: "SCHEDULED", sendAt: { lte: now } } });
    return { sent, failed, remaining };
  }
}

/** Mounted at /api/v1/jobs/:jobId/emails/schedule: schedule an application email for one job. */
export function scheduleEmailRouter(service: ScheduledEmailService): Router {
  const router = Router({ mergeParams: true });
  router.post("/", async (req, res) => {
    const jobId = uuidParam(req, "jobId", new ApiError(404, "JOB_NOT_FOUND", "Job not found."));
    res.status(201).json(await service.schedule(currentUser(res), jobId, body(req, scheduleSchema)));
  });
  return router;
}

/** Mounted at /api/v1/scheduled-emails: the user's scheduled emails. */
export function scheduledEmailsRouter(service: ScheduledEmailService): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    res.json(await service.list(currentUser(res)));
  });
  router.patch("/:id", async (req, res) => {
    res.json(await service.reschedule(currentUser(res), uuidParam(req, "id", notFound()), body(req, rescheduleSchema).sendAt));
  });
  router.post("/:id/send-now", async (req, res) => {
    res.json(await service.sendNow(currentUser(res), uuidParam(req, "id", notFound())));
  });
  router.delete("/:id", async (req, res) => {
    res.json(await service.cancel(currentUser(res), uuidParam(req, "id", notFound())));
  });
  return router;
}

/**
 * Mounted at /api/v1/internal/scheduled-emails/run, outside user sign-in: the pinger calls it with
 * "Authorization: Bearer <SCHEDULER_SECRET>". Without a secret configured the route doesn't exist (404).
 */
export function schedulerRunRouter(service: ScheduledEmailService, secret: string | null): Router {
  const router = Router();
  router.all("/", async (req, res) => {
    if (!secret) throw new ApiError(404, "NOT_FOUND", "Not found.");
    const given = Buffer.from(req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
    const expected = Buffer.from(secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid scheduler secret.");
    }
    if (req.method !== "POST" && req.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST or GET.");
    res.set("Cache-Control", "no-store").json(await service.runDue());
  });
  return router;
}
