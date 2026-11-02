import { describe, expect, it } from "vitest";

import type { SentEmailResponse } from "../../src/applications/application-emails.js";
import { followUpsDue } from "../../src/applications/follow-ups.js";

const now = new Date("2026-11-20T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

const email = (id: string, sentDaysAgo: number, status: SentEmailResponse["status"] = "DELIVERED"): SentEmailResponse => ({
  id, recipient: "hr@acme.com", subject: "Application", templateId: null, sentAt: daysAgo(sentDaysAgo), status,
  deliveryStatus: status === "BOUNCED" ? "BOUNCED" : "DELIVERED", bouncedAt: null, openTracked: true, openCount: 0,
  firstOpenedAt: null, lastOpenedAt: null, replyCount: status === "REPLIED" ? 1 : 0, repliedAt: null, checkedAt: now,
});

const job = (id: string, emails: SentEmailResponse[], updatedDaysAgo = 1) =>
  ({ id, title: "Engineer", company: "Acme", updatedAt: daysAgo(updatedDaysAgo), emails });

describe("follow-ups", () => {
  it("lists unanswered, bounced and email-less applications, oldest first", () => {
    const due = followUpsDue([
      job("waiting", [email("a", 9)]),
      job("recent", [email("b", 3)]),
      job("answered", [email("c", 20), email("d", 12, "REPLIED")]),
      job("bounced", [email("e", 2, "BOUNCED")]),
      job("manual", [], 10),
      job("second", [email("f", 30), email("g", 14)]),
      job("done", [email("h", 40), email("i", 30), email("j", 20)]),
    ], now);
    expect(due.map((item) => [item.kind, item.job.id, item.days])).toEqual([
      ["DUE", "second", 14], ["NO_EMAIL", "manual", 10], ["DUE", "waiting", 9], ["BOUNCED", "bounced", 2],
    ]);
    expect(due[0]).toMatchObject({ followUpNumber: 2, lastEmail: { id: "g" } });
  });
});
