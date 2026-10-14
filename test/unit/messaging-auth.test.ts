import { describe, expect, it } from "vitest";

import { formatApplicationDate } from "../../src/applications/application-emails.js";
import { checkClaims } from "../../src/auth/clerk.js";
import { SvixVerifier } from "../../src/auth/svix.js";
import { profileFrom } from "../../src/auth/webhook.js";
import { GmailApiClient, GmailService } from "../../src/gmail/gmail.js";
import { ClerkGoogleAccounts, GMAIL_SEND_SCOPE } from "../../src/gmail/google-accounts.js";
import { buildMimeMessage, encodeHeader, escapeHtml } from "../../src/gmail/mime.js";
import { invalidPlaceholders, remainingPlaceholders, resolve } from "../../src/templates/merge-fields.js";
import { previewTemplate } from "../../src/templates/templates.js";
import { mergeProfile, normaliseEmail } from "../../src/users/users.js";
import { FakeGmail, FakeGoogleAccounts, memoryUsers } from "../helpers.js";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("merge fields", () => {
  it("fills known placeholders and reports missing and unknown ones", () => {
    const result = resolve("Hi {{candidate_name}} at {{ company_name }} {{unknown}} {{job_location}}",
      { candidate_name: "Priya", company_name: "Acme", job_location: null });
    expect(result.text).toBe("Hi Priya at Acme {{unknown}} {{job_location}}");
    expect(result.missing).toEqual(["job_location"]);
    expect(result.unknown).toEqual(["{{unknown}}"]);
  });

  it("never evaluates values", () => {
    expect(resolve("{{job_title}}", { job_title: "{{candidate_email}} $& $1" }).text).toBe("{{candidate_email}} $& $1");
  });

  it("finds invalid and leftover placeholders", () => {
    expect(invalidPlaceholders("{{job_title}} {{bad}} {{oops")).toEqual(["{{bad}}", "{{"]);
    expect(remainingPlaceholders("Dear {{candidate_name}}, see }}")).toEqual(["{{candidate_name}}", "}}"]);
  });

  it("previews with sample data", () => {
    expect(previewTemplate("Re: {{job_title}}", "{{nope}}")).toEqual({
      subject: "Re: Backend Engineer", body: "{{nope}}", unknownPlaceholders: ["{{nope}}"],
    });
  });

  it("formats the application date in the user's time zone", () => {
    const date = new Date("2026-10-11T20:00:00Z");
    expect(formatApplicationDate(date, "Asia/Kolkata")).toBe("12 October 2026");
    expect(formatApplicationDate(date, "Not/AZone")).toBe("11 October 2026");
    expect(formatApplicationDate(date, null)).toBe("11 October 2026");
  });
});

describe("MIME messages", () => {
  it("builds a text + HTML message", () => {
    const message = buildMimeMessage("hr@acme.com", "Application", "Hello <b>\nThanks");
    expect(message).toMatch(/^To: hr@acme.com\r\nSubject: Application\r\nMIME-Version: 1.0\r\n/);
    expect(message).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(message).toContain(Buffer.from("Hello <b>\r\nThanks", "utf8").toString("base64"));
    expect(message).not.toMatch(/^From:/m);
  });

  it("refuses header injection", () => {
    expect(() => buildMimeMessage("a@b.com\r\nBcc: x@y.com", "Hi", "x")).toThrow();
    expect(() => buildMimeMessage("a@b.com", "Hi\nBcc: x@y.com", "x")).toThrow();
  });

  it("encodes non-ASCII subjects", () => {
    const encoded = encodeHeader("Résumé for Zoë");
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
    const decoded = encoded.split("\r\n ").map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("");
    expect(decoded).toBe("Résumé for Zoë");
    expect(encodeHeader("Plain")).toBe("Plain");
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("Gmail", () => {
  const user = () => memoryUsers.resolve("user_1");

  it("reports status from the Google account", async () => {
    const google = new FakeGoogleAccounts();
    const gmail = new GmailService(google, new FakeGmail());
    expect(await gmail.status(await user())).toEqual({ configured: true, connected: true, canSend: true, googleEmail: "me@gmail.com" });
    google.account = null;
    expect(await gmail.status(await user())).toMatchObject({ connected: false, canSend: false });
    google.configured = false;
    expect(await gmail.status(await user())).toMatchObject({ configured: false });
  });

  it("needs the gmail.send permission to send", async () => {
    const google = new FakeGoogleAccounts();
    google.token = { value: "t", scopes: new Set() };
    const gmail = new GmailService(google, new FakeGmail());
    await expect(gmail.send(await user(), "a@b.com", "Hi", "x")).rejects.toMatchObject({ code: "GMAIL_PERMISSION_MISSING" });
    google.token = null;
    await expect(gmail.send(await user(), "a@b.com", "Hi", "x")).rejects.toMatchObject({ code: "GMAIL_NOT_CONNECTED" });
  });

  it("sends through the Gmail API and maps failures", async () => {
    const calls: { url: string; body: string }[] = [];
    const ok = new GmailApiClient(async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return jsonResponse(200, { id: "m1", threadId: "t1" });
    });
    const token = { value: "t", scopes: new Set([GMAIL_SEND_SCOPE]) };
    expect(await ok.send(token, "To: a@b.com\r\n\r\nHi")).toEqual({ messageId: "m1", threadId: "t1" });
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(JSON.parse(calls[0]!.body)).toEqual({ raw: Buffer.from("To: a@b.com\r\n\r\nHi").toString("base64url") });

    const expired = new GmailApiClient(async () => jsonResponse(401, {}));
    await expect(expired.send(token, "x")).rejects.toMatchObject({ status: 409, code: "GMAIL_AUTH_FAILED" });
    const rejected = new GmailApiClient(async () => jsonResponse(400, {}));
    await expect(rejected.send(token, "x")).rejects.toMatchObject({ status: 422, code: "GMAIL_REJECTED" });
    const down = new GmailApiClient(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(down.send(token, "x")).rejects.toMatchObject({ status: 502, code: "GMAIL_UNAVAILABLE" });
  });

  it("reads the Google connection from Clerk", async () => {
    const clerk = new ClerkGoogleAccounts("sk_test", async (url) => {
      if (String(url).endsWith("/users/user_1")) {
        return jsonResponse(200, { external_accounts: [{ provider: "oauth_github" },
          { provider: "oauth_google", email_address: "me@gmail.com", approved_scopes: `email ${GMAIL_SEND_SCOPE}` }] });
      }
      if (String(url).includes("/oauth_access_tokens/")) {
        return jsonResponse(200, { data: [{ token: "tok", scopes: [GMAIL_SEND_SCOPE] }] });
      }
      return jsonResponse(404, {});
    });
    const account = await clerk.findGoogleAccount("user_1");
    expect(account?.email).toBe("me@gmail.com");
    expect(account?.approvedScopes.has(GMAIL_SEND_SCOPE)).toBe(true);
    expect((await clerk.findAccessToken("user_1"))?.value).toBe("tok");
    expect(await clerk.findGoogleAccount("user_2")).toBeNull();

    const failing = new ClerkGoogleAccounts("sk_test", async () => jsonResponse(500, {}));
    await expect(failing.findGoogleAccount("user_1")).rejects.toMatchObject({ code: "GMAIL_UNAVAILABLE" });
    const unconfigured = new ClerkGoogleAccounts(null);
    await expect(unconfigured.findGoogleAccount("user_1")).rejects.toMatchObject({ code: "GMAIL_NOT_CONFIGURED" });
  });
});

describe("Clerk tokens", () => {
  it("accepts allowed or absent authorized parties", () => {
    expect(checkClaims({ sub: "user_1", azp: "http://localhost:3000", email: "A@B.com", name: "A" }, ["http://localhost:3000"]))
      .toEqual({ subject: "user_1", profile: { email: "A@B.com", name: "A", picture: null } });
    expect(checkClaims({ sub: "user_1" }, ["http://localhost:3000"]).subject).toBe("user_1");
  });

  it("rejects other origins and tokens without a subject", () => {
    expect(() => checkClaims({ sub: "user_1", azp: "https://evil.example" }, ["http://localhost:3000"])).toThrow();
    expect(() => checkClaims({}, [])).toThrow();
  });
});

describe("user profiles", () => {
  it("normalizes email and keeps existing values for missing claims", () => {
    expect(normaliseEmail("  Raj@Gmail.COM ")).toBe("raj@gmail.com");
    const current = { email: "a@b.com", displayName: "Old", avatarUrl: "https://img/x" };
    expect(mergeProfile(current, { email: null, name: ` ${"n".repeat(120)} `, picture: undefined })).toEqual({
      email: "a@b.com", displayName: "n".repeat(100), avatarUrl: "https://img/x",
    });
  });

  it("reads the profile from a Clerk webhook user", () => {
    expect(profileFrom({
      id: "user_1", first_name: "Priya", last_name: null, image_url: "https://img/p",
      primary_email_address_id: "e2",
      email_addresses: [{ id: "e1", email_address: "old@x.com" }, { id: "e2", email_address: "Priya@X.com" }],
    })).toEqual({ email: "Priya@X.com", name: "Priya", picture: "https://img/p" });
  });
});

describe("Svix signatures", () => {
  const secret = `whsec_${Buffer.from("a-test-signing-key-32-bytes-long").toString("base64")}`;
  const now = 1_760_000_000_000;
  const verifier = new SvixVerifier(secret, () => now);
  const timestamp = String(now / 1000);

  it("accepts a correctly signed delivery", () => {
    const signature = verifier.sign("msg_1", timestamp, '{"a":1}');
    expect(verifier.isValid("msg_1", timestamp, signature, '{"a":1}')).toBe(true);
    expect(verifier.isValid("msg_1", timestamp, `v1,bm90LWl0 ${signature}`, '{"a":1}')).toBe(true);
  });

  it("rejects changed bodies, old timestamps and missing headers", () => {
    const signature = verifier.sign("msg_1", timestamp, '{"a":1}');
    expect(verifier.isValid("msg_1", timestamp, signature, '{"a":2}')).toBe(false);
    const old = String(now / 1000 - 600);
    expect(verifier.isValid("msg_1", old, verifier.sign("msg_1", old, "x"), "x")).toBe(false);
    expect(verifier.isValid(undefined, timestamp, signature, '{"a":1}')).toBe(false);
    expect(verifier.isValid("msg_1", "abc", signature, '{"a":1}')).toBe(false);
  });
});
