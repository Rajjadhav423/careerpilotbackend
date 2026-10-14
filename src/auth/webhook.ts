import express, { Router } from "express";

import type { ClerkProfile, UserService } from "../users/users.js";
import { SvixVerifier } from "./svix.js";

/*
 * POST /api/v1/webhooks/clerk — keeps our users table following Clerk:
 * user.created / user.updated → create or update the row; session.created → record the sign-in;
 * user.deleted → delete the user and their data. Disabled (503) until CLERK_WEBHOOK_SECRET is set.
 * Reads the raw body: the signature covers the exact bytes Clerk sent.
 */

type EmailAddress = { id?: string; email_address?: string };
type ClerkEventData = {
  id?: string;
  user_id?: string;
  created_at?: number;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: EmailAddress[];
};

export function profileFrom(data: ClerkEventData): ClerkProfile {
  const name = [data.first_name, data.last_name].filter((part) => part && part.trim()).join(" ");
  const email = data.email_addresses?.find((address) => address.id === data.primary_email_address_id)?.email_address;
  return { email: email ?? null, name: name || null, picture: data.image_url ?? null };
}

export function clerkWebhookRouter(secret: string | null, users: UserService, now?: () => number): Router {
  const verifier = secret ? new SvixVerifier(secret, now) : null;
  const router = Router();

  router.post("/", express.text({ type: "*/*", limit: "1mb" }), async (req, res) => {
    if (!verifier) return void res.status(503).end();
    const body = typeof req.body === "string" ? req.body : "";
    const header = (name: string) => req.get(name) ?? undefined;
    if (!verifier.isValid(header("svix-id"), header("svix-timestamp"), header("svix-signature"), body)) {
      console.warn(`Rejected Clerk webhook with an invalid signature (svix-id=${header("svix-id")})`);
      return void res.status(401).end();
    }

    let event: { type?: string; data?: ClerkEventData };
    try {
      event = JSON.parse(body);
    } catch {
      return void res.status(400).end();
    }
    const data = event.data;
    if (!data?.id) return void res.status(400).end();

    switch (event.type) {
      case "user.created":
      case "user.updated":
        await users.upsertFromClerk(data.id, profileFrom(data));
        break;
      case "session.created":
        if (data.user_id) {
          // Clerk timestamps are milliseconds since the epoch
          await users.recordSignIn(data.user_id, typeof data.created_at === "number" ? new Date(data.created_at) : null);
        }
        break;
      case "user.deleted":
        await users.deleteFromClerk(data.id);
        break;
      default:
        break;
    }
    res.status(204).end();
  });

  return router;
}
