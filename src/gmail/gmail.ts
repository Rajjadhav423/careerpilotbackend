import { Router } from "express";

import { currentUser } from "../auth/clerk.js";
import { ApiError } from "../http/errors.js";
import type { User } from "../users/users.js";
import {
  GMAIL_COMPOSE_SCOPE, GMAIL_METADATA_SCOPE, GMAIL_SEND_SCOPE, type GoogleAccessToken, type GoogleAccounts,
} from "./google-accounts.js";
import { buildMimeMessage, type MimeAttachment, type MimeOptions } from "./mime.js";

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
  /** That Google account granted gmail.metadata, so bounces and replies can be tracked */
  canTrack: boolean;
  /** That Google account granted gmail.compose, so emails can be scheduled (they wait as Gmail drafts) */
  canSchedule: boolean;
  /** The Gmail address emails will be sent from (no token data) */
  googleEmail: string | null;
};

/** Gmail's confirmation that it accepted the message. */
export type SentMessage = { messageId: string; threadId: string | null };

/** One message in a Gmail thread, headers only. */
export type ThreadMessage = {
  id: string;
  /** The From header as written, e.g. "Jane <jane@acme.com>" */
  from: string;
  /** When Gmail received (or sent) it */
  date: Date;
  /** Gmail labels, e.g. SENT, INBOX */
  labelIds: string[];
};

export interface GmailSender {
  /** threadId: send into this existing Gmail thread (a follow-up) */
  send(token: GoogleAccessToken, rfc5322Message: string, threadId?: string | null): Promise<SentMessage>;
  /** The Message-ID header of one of the user's messages, or null when Gmail doesn't have it. */
  messageIdHeader(token: GoogleAccessToken, messageId: string): Promise<string | null>;
  /** The thread's messages (headers only), or null when Gmail no longer has the thread. */
  thread(token: GoogleAccessToken, threadId: string): Promise<ThreadMessage[] | null>;
  /** Saves the message as a draft in the user's Gmail (in threadId's thread for a follow-up). */
  createDraft(token: GoogleAccessToken, rfc5322Message: string, threadId?: string | null): Promise<{ draftId: string }>;
  /** Sends a draft as it is now in Gmail (including edits the user made there). Null when the draft no longer exists. */
  sendDraft(token: GoogleAccessToken, draftId: string): Promise<SentMessage | null>;
  /** Deletes a draft; already deleted counts as done. */
  deleteDraft(token: GoogleAccessToken, draftId: string): Promise<void>;
}

/** Gmail's errors as API errors; only the status is logged (never tokens, recipients or content). */
function gmailError(status: number, action: string): ApiError {
  console.warn(`Gmail ${action} failed with status ${status}`);
  switch (status) {
    case 401:
      return new ApiError(409, "GMAIL_AUTH_FAILED", "Your Google connection has expired. Reconnect Gmail and try again.");
    case 403:
      return new ApiError(409, "GMAIL_PERMISSION_MISSING",
        "CareerPilot isn't allowed to do this in your Gmail. Reconnect Gmail and allow the requested access.");
    case 400:
      return new ApiError(422, "GMAIL_REJECTED", "Gmail rejected the message. Check the recipient address and try again.");
    default:
      return gmailUnavailable();
  }
}

/** gmail.readonly includes everything gmail.metadata allows. */
const TRACKING_SCOPES = [GMAIL_METADATA_SCOPE, "https://www.googleapis.com/auth/gmail.readonly"];
const canTrack = (scopes: Set<string>) => TRACKING_SCOPES.some((scope) => scopes.has(scope));
/** gmail.compose includes sending */
const canSend = (scopes: Set<string>) => scopes.has(GMAIL_SEND_SCOPE) || scopes.has(GMAIL_COMPOSE_SCOPE);

const gmailUnavailable = (detail = "Gmail is unavailable right now. Your email was not sent; please try again shortly.") =>
  new ApiError(502, "GMAIL_UNAVAILABLE", detail);

/** Sends a prepared message through the Gmail API as the signed-in user. */
export class GmailApiClient implements GmailSender {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://gmail.googleapis.com",
  ) {}

  async send(token: GoogleAccessToken, rfc5322Message: string, threadId?: string | null): Promise<SentMessage> {
    const raw = Buffer.from(rfc5322Message, "utf8").toString("base64url");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/gmail/v1/users/me/messages/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
        body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
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

  async messageIdHeader(token: GoogleAccessToken, messageId: string): Promise<string | null> {
    const url = `${this.baseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`
      + "?format=metadata&metadataHeaders=Message-ID&fields=payload/headers";
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token.value}` }, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      console.warn(`Gmail unreachable: ${(error as Error).name}`);
      return null;
    }
    if (!response.ok) {
      console.warn(`Gmail message read failed with status ${response.status}`);
      return null;
    }
    const result = (await response.json().catch(() => null)) as { payload?: { headers?: { name?: string; value?: string }[] } } | null;
    return result?.payload?.headers?.find((header) => header.name?.toLowerCase() === "message-id")?.value?.trim() || null;
  }

  async thread(token: GoogleAccessToken, threadId: string): Promise<ThreadMessage[] | null> {
    const url = `${this.baseUrl}/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`
      + "?format=metadata&metadataHeaders=From&fields=messages(id,labelIds,internalDate,payload/headers)";
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token.value}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.warn(`Gmail unreachable: ${(error as Error).name}`);
      throw gmailUnavailable("Couldn't check Gmail right now. Please try again shortly.");
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`Gmail thread read failed with status ${response.status}`);
      throw gmailUnavailable("Couldn't check Gmail right now. Please try again shortly.");
    }
    const result = (await response.json().catch(() => null)) as {
      messages?: { id?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: { name?: string; value?: string }[] } }[];
    } | null;
    return (result?.messages ?? []).filter((message) => message.id).map((message) => ({
      id: message.id!,
      from: message.payload?.headers?.find((header) => header.name?.toLowerCase() === "from")?.value ?? "",
      date: new Date(Number(message.internalDate ?? 0)),
      labelIds: message.labelIds ?? [],
    }));
  }

  private async call(token: GoogleAccessToken, path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}/gmail/v1/users/me/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      console.warn(`Gmail unreachable: ${(error as Error).name}`);
      throw gmailUnavailable();
    }
  }

  async createDraft(token: GoogleAccessToken, rfc5322Message: string, threadId?: string | null): Promise<{ draftId: string }> {
    const raw = Buffer.from(rfc5322Message, "utf8").toString("base64url");
    const response = await this.call(token, "drafts", {
      method: "POST", body: JSON.stringify({ message: threadId ? { raw, threadId } : { raw } }),
    });
    if (!response.ok) throw gmailError(response.status, "draft create");
    const result = (await response.json().catch(() => null)) as { id?: string } | null;
    if (!result?.id) throw gmailUnavailable("Gmail didn't confirm the draft. Please try again.");
    return { draftId: result.id };
  }

  async sendDraft(token: GoogleAccessToken, draftId: string): Promise<SentMessage | null> {
    const response = await this.call(token, "drafts/send", { method: "POST", body: JSON.stringify({ id: draftId }) });
    if (response.status === 404) return null;
    if (!response.ok) throw gmailError(response.status, "draft send");
    const result = (await response.json().catch(() => null)) as { id?: string; threadId?: string } | null;
    if (!result?.id) throw gmailUnavailable("Gmail didn't confirm the message. Check your Sent folder.");
    return { messageId: result.id, threadId: result.threadId ?? null };
  }

  async deleteDraft(token: GoogleAccessToken, draftId: string): Promise<void> {
    const response = await this.call(token, `drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw gmailError(response.status, "draft delete");
  }
}

export class GmailService {
  constructor(
    private readonly accounts: GoogleAccounts,
    private readonly gmail: GmailSender,
  ) {}

  async status(user: User): Promise<GmailStatus> {
    if (!this.accounts.configured) {
      return { configured: false, connected: false, canSend: false, canTrack: false, canSchedule: false, googleEmail: null };
    }
    const account = await this.accounts.findGoogleAccount(user.clerkUserId);
    return account
      ? {
        configured: true, connected: true, canSend: canSend(account.approvedScopes),
        canTrack: canTrack(account.approvedScopes), canSchedule: account.approvedScopes.has(GMAIL_COMPOSE_SCOPE),
        googleEmail: account.email,
      }
      : { configured: true, connected: false, canSend: false, canTrack: false, canSchedule: false, googleEmail: null };
  }

  /** Sends from the user's own Gmail. Returns only after Gmail confirms it accepted the message. */
  /**
   * replyTo: a follow-up goes into the original's Gmail thread; with the gmail.metadata permission it also carries
   * In-Reply-To, so the recipient's mail app shows it in the same conversation.
   */
  async send(
    user: User, to: string, subject: string, body: string, attachment?: MimeAttachment, trackingPixelUrl?: string,
    replyTo?: { gmailMessageId: string; gmailThreadId: string | null },
  ): Promise<SentMessage> {
    if (!this.accounts.configured) {
      throw new ApiError(503, "GMAIL_NOT_CONFIGURED", "Gmail isn't set up on this server yet.");
    }
    const token = await this.accounts.findAccessToken(user.clerkUserId);
    if (!token) throw new ApiError(409, "GMAIL_NOT_CONNECTED", "Connect your Gmail account to send emails.");
    if (!canSend(token.scopes)) {
      throw new ApiError(409, "GMAIL_PERMISSION_MISSING",
        "Your Google connection doesn't allow sending email yet. Reconnect Gmail and allow sending.");
    }
    const inReplyTo = replyTo && canTrack(token.scopes) ? await this.gmail.messageIdHeader(token, replyTo.gmailMessageId) : null;
    const options: MimeOptions = { trackingPixelUrl, inReplyTo };
    return this.gmail.send(token, buildMimeMessage(to, subject, body, attachment, options), replyTo?.gmailThreadId);
  }

  /** The user's token with gmail.compose, for scheduled emails (drafts). */
  private async composeToken(clerkUserId: string): Promise<GoogleAccessToken> {
    if (!this.accounts.configured) throw new ApiError(503, "GMAIL_NOT_CONFIGURED", "Gmail isn't set up on this server yet.");
    const token = await this.accounts.findAccessToken(clerkUserId);
    if (!token) throw new ApiError(409, "GMAIL_NOT_CONNECTED", "Connect your Gmail account to schedule emails.");
    if (!token.scopes.has(GMAIL_COMPOSE_SCOPE)) {
      throw new ApiError(409, "GMAIL_SCHEDULE_PERMISSION_MISSING",
        "Scheduling needs permission to create drafts in your Gmail. Reconnect Gmail and allow it.");
    }
    return token;
  }

  /** Saves the email as a draft in the user's Gmail, where it waits until it's sent. The same message send() builds. */
  async createDraft(
    user: User, to: string, subject: string, body: string, attachment?: MimeAttachment, trackingPixelUrl?: string,
    replyTo?: { gmailMessageId: string; gmailThreadId: string | null },
  ): Promise<{ draftId: string }> {
    const token = await this.composeToken(user.clerkUserId);
    const inReplyTo = replyTo && canTrack(token.scopes) ? await this.gmail.messageIdHeader(token, replyTo.gmailMessageId) : null;
    const options: MimeOptions = { trackingPixelUrl, inReplyTo };
    return this.gmail.createDraft(token, buildMimeMessage(to, subject, body, attachment, options), replyTo?.gmailThreadId);
  }

  /** Sends a scheduled email's draft; null when the user deleted the draft in Gmail. */
  async sendDraft(user: User, draftId: string): Promise<SentMessage | null> {
    return this.gmail.sendDraft(await this.composeToken(user.clerkUserId), draftId);
  }

  async deleteDraft(user: User, draftId: string): Promise<void> {
    return this.gmail.deleteDraft(await this.composeToken(user.clerkUserId), draftId);
  }

  /**
   * The headers of a sent email's thread, or null when tracking isn't possible (no Google connection, no
   * gmail.metadata permission, or the thread was deleted). Never throws for a missing permission.
   */
  async threadMessages(user: User, threadId: string): Promise<ThreadMessage[] | null> {
    if (!this.accounts.configured) return null;
    const token = await this.accounts.findAccessToken(user.clerkUserId);
    if (!token || !canTrack(token.scopes)) return null;
    return this.gmail.thread(token, threadId);
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
