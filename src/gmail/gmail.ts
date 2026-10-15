import { Router } from "express";

import { currentUser } from "../auth/clerk.js";
import { ApiError } from "../http/errors.js";
import type { User } from "../users/users.js";
import { GMAIL_SEND_SCOPE, type GoogleAccessToken, type GoogleAccounts } from "./google-accounts.js";
import { buildMimeMessage, type MimeAttachment } from "./mime.js";

/*
 * Gmail for the signed-in user only: the Clerk user id always comes from their verified session token, so nobody
 * can use another person's connected account.
 */

export type GmailStatus = {
  /** The server has a Clerk secret key */
  configured: boolean;
  /** The user has a Google account linked in Clerk */
  connected: boolean;
  /** That Google account granted the gmail.send permission */
  canSend: boolean;
  /** The Gmail address emails will be sent from (no token data) */
  googleEmail: string | null;
};

/** Gmail's confirmation that it accepted the message. */
export type SentMessage = { messageId: string; threadId: string | null };

export interface GmailSender {
  send(token: GoogleAccessToken, rfc5322Message: string): Promise<SentMessage>;
}

const gmailUnavailable = (detail = "Gmail is unavailable right now. Your email was not sent; please try again shortly.") =>
  new ApiError(502, "GMAIL_UNAVAILABLE", detail);

/** Sends a prepared message through the Gmail API as the signed-in user. */
export class GmailApiClient implements GmailSender {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://gmail.googleapis.com",
  ) {}

  async send(token: GoogleAccessToken, rfc5322Message: string): Promise<SentMessage> {
    const raw = Buffer.from(rfc5322Message, "utf8").toString("base64url");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/gmail/v1/users/me/messages/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      console.warn(`Gmail unreachable: ${(error as Error).name}`);
      throw gmailUnavailable();
    }
    if (!response.ok) {
      // Status only: never log tokens, recipients or message content
      console.warn(`Gmail send failed with status ${response.status}`);
      switch (response.status) {
        case 401:
          throw new ApiError(409, "GMAIL_AUTH_FAILED", "Your Google connection has expired. Reconnect Gmail and try again.");
        case 403:
          throw new ApiError(409, "GMAIL_PERMISSION_MISSING",
            "CareerPilot isn't allowed to send email from your Gmail. Reconnect Gmail and allow sending.");
        case 400:
          throw new ApiError(422, "GMAIL_REJECTED", "Gmail rejected the message. Check the recipient address and try again.");
        default:
          throw gmailUnavailable();
      }
    }
    const result = (await response.json().catch(() => null)) as { id?: string; threadId?: string } | null;
    if (!result?.id?.trim()) {
      console.warn("Gmail send returned no message id");
      throw gmailUnavailable("Gmail didn't confirm the message. Check your Sent folder before trying again.");
    }
    return { messageId: result.id, threadId: result.threadId ?? null };
  }
}

export class GmailService {
  constructor(
    private readonly accounts: GoogleAccounts,
    private readonly gmail: GmailSender,
  ) {}

  async status(user: User): Promise<GmailStatus> {
    if (!this.accounts.configured) return { configured: false, connected: false, canSend: false, googleEmail: null };
    const account = await this.accounts.findGoogleAccount(user.clerkUserId);
    return account
      ? { configured: true, connected: true, canSend: account.approvedScopes.has(GMAIL_SEND_SCOPE), googleEmail: account.email }
      : { configured: true, connected: false, canSend: false, googleEmail: null };
  }

  /** Sends from the user's own Gmail. Returns only after Gmail confirms it accepted the message. */
  async send(user: User, to: string, subject: string, body: string, attachment?: MimeAttachment): Promise<SentMessage> {
    if (!this.accounts.configured) {
      throw new ApiError(503, "GMAIL_NOT_CONFIGURED", "Gmail isn't set up on this server yet.");
    }
    const token = await this.accounts.findAccessToken(user.clerkUserId);
    if (!token) throw new ApiError(409, "GMAIL_NOT_CONNECTED", "Connect your Gmail account to send emails.");
    if (!token.scopes.has(GMAIL_SEND_SCOPE)) {
      throw new ApiError(409, "GMAIL_PERMISSION_MISSING",
        "Your Google connection doesn't allow sending email yet. Reconnect Gmail and allow sending.");
    }
    return this.gmail.send(token, buildMimeMessage(to, subject, body, attachment));
  }
}

export function gmailRouter(gmail: GmailService): Router {
  const router = Router();
  /** Whether the signed-in user can send from Gmail, and from which address. Never includes tokens. */
  router.get("/status", async (_req, res) => {
    res.json(await gmail.status(currentUser(res)));
  });
  return router;
}
