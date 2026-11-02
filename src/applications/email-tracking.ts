import { randomBytes } from "node:crypto";

import { Router } from "express";

import type { Db } from "../db/prisma.js";
import type { ThreadMessage } from "../gmail/gmail.js";

/*
 * Tracking for application emails, in three parts:
 * - Delivered / bounced: a bounce (from mailer-daemon or postmaster) lands in the sent email's Gmail thread. No bounce a
 *   few minutes after sending is reported as DELIVERED; mail servers give no stronger proof than that.
 * - Replied: any other message in the thread that the user didn't send.
 *   Both read only message headers, with the optional gmail.metadata permission.
 * - Opened: a 1x1 image in the HTML part, served by the public pixel route below. Approximate by nature: images may be
 *   blocked (no open seen) or fetched by privacy proxies (an open that wasn't a person).
 */

export type DeliveryStatus = "SENT" | "DELIVERED" | "BOUNCED";
/** The single most useful status for a list: replied beats bounced beats opened beats delivered. */
export type TrackingStatus = "SENT" | "DELIVERED" | "OPENED" | "REPLIED" | "BOUNCED";

/** No bounce after this long counts as delivered (bounces normally come back within a minute or two). */
export const DELIVERED_AFTER_MS = 10 * 60_000;
/** Gmail threads are checked again at most this often per email. */
export const RECHECK_AFTER_MS = 5 * 60_000;
/** Threads stop being checked this long after sending. */
export const TRACK_FOR_MS = 30 * 24 * 60 * 60_000;
/** Image loads this soon after sending are the sender's own Gmail showing the sent message, not the recipient. */
export const IGNORE_OPENS_FOR_MS = 60_000;

const BOUNCE_SENDER = /mailer-daemon@|postmaster@|mail delivery (subsystem|system)/i;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export const newTrackingToken = () => randomBytes(24).toString("base64url");

export const pixelUrl = (baseUrl: string, token: string) => `${baseUrl.replace(/\/+$/, "")}/api/v1/t/${token}.gif`;

export type ThreadFindings = {
  deliveryStatus: DeliveryStatus;
  bouncedAt: Date | null;
  replyCount: number;
  repliedAt: Date | null;
};

/** What a sent email's thread says about it. A DELIVERED status already known (e.g. from an open) is kept. */
export function readThread(
  messages: ThreadMessage[], sent: { gmailMessageId: string; sentAt: Date; deliveryStatus: string }, now: Date,
): ThreadFindings {
  const others = messages.filter((message) => message.id !== sent.gmailMessageId && !message.labelIds.includes("SENT"));
  const bounces = others.filter((message) => BOUNCE_SENDER.test(message.from));
  const replies = others.filter((message) => !BOUNCE_SENDER.test(message.from) && message.date >= sent.sentAt);
  const first = (list: ThreadMessage[]) =>
    list.length === 0 ? null : new Date(Math.min(...list.map((message) => message.date.getTime())));

  // A reply proves delivery even if some other address in the thread bounced earlier
  const deliveryStatus: DeliveryStatus = replies.length > 0 ? "DELIVERED"
    : bounces.length > 0 ? "BOUNCED"
      : sent.deliveryStatus === "DELIVERED" || now.getTime() - sent.sentAt.getTime() >= DELIVERED_AFTER_MS ? "DELIVERED"
        : "SENT";
  return {
    deliveryStatus,
    bouncedAt: deliveryStatus === "BOUNCED" ? first(bounces) : null,
    replyCount: replies.length,
    repliedAt: first(replies),
  };
}

export function trackingStatus(email: { deliveryStatus: string; openCount: number; replyCount: number }): TrackingStatus {
  if (email.replyCount > 0) return "REPLIED";
  if (email.deliveryStatus === "BOUNCED") return "BOUNCED";
  if (email.openCount > 0) return "OPENED";
  return email.deliveryStatus === "DELIVERED" ? "DELIVERED" : "SENT";
}

/** A transparent 1x1 GIF. */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Public (no sign-in: mail clients load it): GET /t/<token>.gif records an open and always returns the image, so it
 * never reveals whether a token exists.
 */
export function trackingPixelRouter(db: Db, now: () => Date = () => new Date()): Router {
  const router = Router();
  router.get("/:file", async (req, res) => {
    const token = String(req.params.file ?? "").replace(/\.gif$/, "");
    if (TOKEN.test(token)) {
      const at = now();
      const where = { trackingToken: token, sentAt: { lt: new Date(at.getTime() - IGNORE_OPENS_FOR_MS) } };
      try {
        const { count } = await db.sentEmail.updateMany({ where, data: { openCount: { increment: 1 }, lastOpenedAt: at } });
        if (count > 0) {
          await db.sentEmail.updateMany({ where: { ...where, firstOpenedAt: null }, data: { firstOpenedAt: at } });
          // Opened means it arrived
          await db.sentEmail.updateMany({ where: { ...where, deliveryStatus: "SENT" }, data: { deliveryStatus: "DELIVERED" } });
        }
      } catch (error) {
        console.warn(`Couldn't record an email open: ${(error as Error).name}`);
      }
    }
    res.set({
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Content-Length": String(PIXEL.length),
    });
    res.end(PIXEL);
  });
  return router;
}
