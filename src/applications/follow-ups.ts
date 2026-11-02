import { Router } from "express";

import { currentUser } from "../auth/clerk.js";
import type { User } from "../users/users.js";
import type { SentEmailResponse } from "./application-emails.js";

/*
 * Applications waiting on the user, from the sent emails' tracking. One set of rules for the dashboard and the
 * MCP server. Only jobs still in APPLIED count: a reply, an interview or a rejection means the conversation moved on.
 * Replies are read from the Gmail thread, so emails sent before reply tracking was allowed may show as due although
 * HR answered.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** No reply this long after the last email: time to follow up */
export const FOLLOW_UP_AFTER_DAYS = 7;
/** At most this many follow-ups per application; after that, move on */
export const MAX_FOLLOW_UPS = 2;

export type FollowUpJob = { id: string; title: string; company: string; updatedAt: Date };

/**
 * - DUE: the last email got no reply for FOLLOW_UP_AFTER_DAYS; follow up in its thread (replyToId = lastEmail.id)
 * - BOUNCED: the last email bounced; find another address
 * - NO_EMAIL: marked Applied without an email from CareerPilot and unchanged for FOLLOW_UP_AFTER_DAYS
 */
export type FollowUp =
  | { kind: "DUE"; job: FollowUpJob; days: number; lastEmail: SentEmailResponse; followUpNumber: number }
  | { kind: "BOUNCED"; job: FollowUpJob; days: number; lastEmail: SentEmailResponse }
  | { kind: "NO_EMAIL"; job: FollowUpJob; days: number };

/** Oldest first. `emails` are each job's sent emails, in any order. */
export function followUpsDue(jobs: (FollowUpJob & { emails: SentEmailResponse[] })[], now: Date): FollowUp[] {
  const due: FollowUp[] = [];
  const daysSince = (date: Date) => Math.floor((now.getTime() - date.getTime()) / DAY_MS);
  for (const { emails, ...job } of jobs) {
    if (emails.length === 0) {
      const days = daysSince(job.updatedAt);
      if (days >= FOLLOW_UP_AFTER_DAYS) due.push({ kind: "NO_EMAIL", job, days });
      continue;
    }
    if (emails.some((email) => email.status === "REPLIED")) continue;
    const lastEmail = [...emails].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0]!;
    const days = daysSince(lastEmail.sentAt);
    if (lastEmail.status === "BOUNCED") due.push({ kind: "BOUNCED", job, days, lastEmail });
    else if (days >= FOLLOW_UP_AFTER_DAYS && emails.length <= MAX_FOLLOW_UPS) {
      due.push({ kind: "DUE", job, days, lastEmail, followUpNumber: emails.length });
    }
  }
  return due.sort((a, b) => b.days - a.days);
}

/** Mounted at /api/v1/follow-ups */
export function followUpsRouter(service: { followUps(user: User): Promise<FollowUp[]> }): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    res.json(await service.followUps(currentUser(res)));
  });
  return router;
}
