import { ApiError } from "../http/errors.js";

/*
 * Reads the user's Google connection from Clerk's Backend API (server side, with the Clerk secret key).
 * Clerk stores and refreshes the Google tokens; we never persist them, log them or send them to the browser.
 */

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Google Drive limited to files CareerPilot creates (see drive/). */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type GoogleAccount = { email: string; approvedScopes: Set<string> };

/** A short-lived Google access token. Never log `value`. */
export type GoogleAccessToken = { value: string; scopes: Set<string> };

export interface GoogleAccounts {
  /** False when CLERK_SECRET_KEY isn't set: Gmail and Drive features are then unavailable. */
  readonly configured: boolean;
  findGoogleAccount(clerkUserId: string): Promise<GoogleAccount | null>;
  /** Clerk refreshes an expired Google token before returning it. */
  findAccessToken(clerkUserId: string): Promise<GoogleAccessToken | null>;
}

type Fetch = typeof fetch;

export class ClerkGoogleAccounts implements GoogleAccounts {
  readonly configured: boolean;

  constructor(
    private readonly secretKey: string | null,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = "https://api.clerk.com/v1",
  ) {
    this.configured = !!secretKey;
  }

  async findGoogleAccount(clerkUserId: string): Promise<GoogleAccount | null> {
    const user = (await this.get(`/users/${encodeURIComponent(clerkUserId)}`)) as {
      external_accounts?: { provider?: string; email_address?: string; approved_scopes?: string }[];
    } | null;
    if (!user) return null;
    for (const account of user.external_accounts ?? []) {
      if (account.provider === "oauth_google" || account.provider === "google") {
        return { email: account.email_address ?? "", approvedScopes: splitScopes(account.approved_scopes ?? "") };
      }
    }
    return null;
  }

  async findAccessToken(clerkUserId: string): Promise<GoogleAccessToken | null> {
    const response = await this.get(
      `/users/${encodeURIComponent(clerkUserId)}/oauth_access_tokens/oauth_google?paginated=true`,
    );
    if (!response) return null;
    const tokens = Array.isArray(response) ? response : (response as { data?: unknown }).data;
    if (!Array.isArray(tokens) || tokens.length === 0) return null;
    const first = tokens[0] as { token?: string; scopes?: string[] };
    if (!first.token?.trim()) return null;
    return { value: first.token, scopes: new Set(first.scopes ?? []) };
  }

  /** The JSON body, or null when Clerk says the user/token doesn't exist (404). */
  private async get(path: string): Promise<unknown> {
    if (!this.configured) {
      throw new ApiError(503, "GMAIL_NOT_CONFIGURED", "Gmail isn't set up on this server yet.");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.warn(`Clerk Backend API unreachable: ${(error as Error).name}`);
      throw unavailable();
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      // Status only: response bodies may contain personal data
      console.warn(`Clerk Backend API call failed with status ${response.status}`);
      throw unavailable();
    }
    return response.json();
  }
}

export function splitScopes(scopes: string): Set<string> {
  return new Set(scopes.split(/[\s,]+/).filter((scope) => scope.trim() !== ""));
}

const unavailable = () =>
  new ApiError(502, "GMAIL_UNAVAILABLE", "Couldn't check your Google connection right now. Please try again shortly.");
