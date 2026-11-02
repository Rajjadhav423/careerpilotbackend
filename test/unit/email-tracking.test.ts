import { describe, expect, it } from "vitest";

import { DELIVERED_AFTER_MS, pixelUrl, readThread, trackingStatus } from "../../src/applications/email-tracking.js";
import { GmailApiClient, GmailService, type ThreadMessage } from "../../src/gmail/gmail.js";
import { GMAIL_METADATA_SCOPE, GMAIL_SEND_SCOPE } from "../../src/gmail/google-accounts.js";
import { buildMimeMessage } from "../../src/gmail/mime.js";
import { FakeGmail, FakeGoogleAccounts, memoryUsers } from "../helpers.js";

const sentAt = new Date("2026-11-01T10:00:00Z");
const sent = { gmailMessageId: "m1", sentAt, deliveryStatus: "SENT" };
const ours: ThreadMessage = { id: "m1", from: "Me <me@gmail.com>", date: sentAt, labelIds: ["SENT"] };
const later = (minutes: number) => new Date(sentAt.getTime() + minutes * 60_000);

describe("reading a sent email's thread", () => {
  it("is SENT until the bounce window passes, then DELIVERED", () => {
    expect(readThread([ours], sent, later(1)).deliveryStatus).toBe("SENT");
    expect(readThread([ours], sent, new Date(sentAt.getTime() + DELIVERED_AFTER_MS)).deliveryStatus).toBe("DELIVERED");
  });

  it("finds bounces from mailer-daemon", () => {
    const bounce = { id: "b1", from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", date: later(1), labelIds: ["INBOX"] };
    expect(readThread([ours, bounce], sent, later(2))).toEqual({
      deliveryStatus: "BOUNCED", bouncedAt: later(1), replyCount: 0, repliedAt: null,
    });
  });

  it("counts replies from others, not the user's own follow-ups", () => {
    const followUp = { id: "m2", from: "Me <me@gmail.com>", date: later(5), labelIds: ["SENT"] };
    const reply = { id: "r1", from: "HR <hr@acme.com>", date: later(30), labelIds: ["INBOX", "UNREAD"] };
    const reply2 = { id: "r2", from: "HR <hr@acme.com>", date: later(60), labelIds: ["INBOX"] };
    expect(readThread([ours, followUp, reply, reply2], sent, later(61))).toEqual({
      deliveryStatus: "DELIVERED", bouncedAt: null, replyCount: 2, repliedAt: later(30),
    });
  });

  it("picks one headline status", () => {
    expect(trackingStatus({ deliveryStatus: "DELIVERED", openCount: 2, replyCount: 1 })).toBe("REPLIED");
    expect(trackingStatus({ deliveryStatus: "BOUNCED", openCount: 0, replyCount: 0 })).toBe("BOUNCED");
    expect(trackingStatus({ deliveryStatus: "DELIVERED", openCount: 1, replyCount: 0 })).toBe("OPENED");
    expect(trackingStatus({ deliveryStatus: "SENT", openCount: 0, replyCount: 0 })).toBe("SENT");
  });
});

describe("open-tracking pixel", () => {
  it("goes in the HTML part only", () => {
    const url = pixelUrl("https://api.example.com/", "abcdefghijklmnopqrstuvwx");
    expect(url).toBe("https://api.example.com/api/v1/t/abcdefghijklmnopqrstuvwx.gif");
    const message = buildMimeMessage("hr@acme.com", "Application", "Hello", undefined, { trackingPixelUrl: url });
    const parts = [...message.matchAll(/Content-Type: (text\/\w+)[^\r]*\r\n[^\r]*\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)]
      .map(([, type, body]) => [type, Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")]);
    expect(parts.find(([type]) => type === "text/html")?.[1]).toContain(`<img src="${url}"`);
    expect(parts.find(([type]) => type === "text/plain")?.[1]).not.toContain(url);
  });
});

describe("follow-ups", () => {
  it("carry In-Reply-To and References and reject anything that isn't one Message-ID", () => {
    const message = buildMimeMessage("hr@acme.com", "Re: Application", "Hi", undefined, { inReplyTo: "<m1@mail.gmail.com>" });
    expect(message).toContain("In-Reply-To: <m1@mail.gmail.com>\r\nReferences: <m1@mail.gmail.com>\r\n");
    expect(() => buildMimeMessage("hr@acme.com", "Re: x", "Hi", undefined, { inReplyTo: "<a>\r\nBcc: x@y.com" })).toThrow();
  });

  it("go into the original thread, with In-Reply-To only when headers can be read", async () => {
    const google = new FakeGoogleAccounts();
    const fake = new FakeGmail();
    const gmail = new GmailService(google, fake);
    const original = { gmailMessageId: "m1", gmailThreadId: "t1" };
    await gmail.send(await memoryUsers.resolve("user_1"), "hr@acme.com", "Re: Application", "Hi", undefined, undefined, original);
    expect(fake.sent[0].threadId).toBe("t1");
    expect(fake.sent[0].message).not.toContain("In-Reply-To");
    google.token = { value: "x", scopes: new Set([GMAIL_SEND_SCOPE, GMAIL_METADATA_SCOPE]) };
    await gmail.send(await memoryUsers.resolve("user_1"), "hr@acme.com", "Re: Application", "Hi", undefined, undefined, original);
    expect(fake.sent[1].message).toContain("In-Reply-To: <m1@mail.gmail.com>");
  });
});

describe("Gmail thread access", () => {
  const user = () => memoryUsers.resolve("user_1");

  it("needs gmail.metadata; without it nothing is read", async () => {
    const google = new FakeGoogleAccounts();
    const fake = new FakeGmail();
    fake.threads.set("t1", [ours]);
    const gmail = new GmailService(google, fake);
    expect(await gmail.threadMessages(await user(), "t1")).toBeNull();
    google.token = { value: "x", scopes: new Set([GMAIL_SEND_SCOPE, GMAIL_METADATA_SCOPE]) };
    expect(await gmail.threadMessages(await user(), "t1")).toEqual([ours]);
  });

  it("reads From headers and dates from the Gmail API", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain("/threads/t1?format=metadata");
      return new Response(JSON.stringify({ messages: [{
        id: "r1", labelIds: ["INBOX"], internalDate: String(later(3).getTime()),
        payload: { headers: [{ name: "From", value: "HR <hr@acme.com>" }] },
      }] }), { status: 200 });
    }) as typeof fetch;
    const messages = await new GmailApiClient(fetchImpl).thread({ value: "x", scopes: new Set() }, "t1");
    expect(messages).toEqual([{ id: "r1", from: "HR <hr@acme.com>", date: later(3), labelIds: ["INBOX"] }]);
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await new GmailApiClient(missing).thread({ value: "x", scopes: new Set() }, "t1")).toBeNull();
  });
});
