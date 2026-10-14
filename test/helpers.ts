import { readFileSync } from "node:fs";
import path from "node:path";

import { createApp, type AppDependencies } from "../src/app.js";
import type { TokenVerifier } from "../src/auth/clerk.js";
import type { Config } from "../src/config.js";
import { createDb, type Db } from "../src/db/prisma.js";
import type { Doc } from "../src/docengine/model.js";
import type { PdfRenderer, RenderedPdf } from "../src/docengine/pdf.js";
import { DriveApiError, type DriveClient, type DriveFile } from "../src/drive/google-drive.js";
import type { GmailSender, SentMessage } from "../src/gmail/gmail.js";
import {
  DRIVE_FILE_SCOPE, GMAIL_SEND_SCOPE, type GoogleAccessToken, type GoogleAccount, type GoogleAccounts,
} from "../src/gmail/google-accounts.js";
import type { User } from "../src/users/users.js";

/* Fakes for every outside service, so tests never reach Clerk, Google, job boards or Chromium. */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databaseUrl: TEST_DATABASE_URL ?? "postgres://unused",
    clerk: {
      issuer: "https://example.clerk.accounts.dev",
      jwksUrl: "https://example.clerk.accounts.dev/.well-known/jwks.json",
      authorizedParties: ["http://localhost:3000"],
      webhookSecret: null,
      secretKey: "sk_test_fake",
    },
    corsOrigins: ["http://localhost:3000"],
    maxRequestBytes: 512 * 1024,
    resumeVersionsEnabled: false,
    pdf: { maxPages: 10, maxBytes: 5 * 1024 * 1024, renderTimeoutMs: 20_000, maxConcurrent: 2, maxQueued: 8 },
    discoveryBoards: ["greenhouse:acme:Acme"],
    ...overrides,
  };
}

/** "Bearer user:<clerk id>" is a valid token for that Clerk user; anything else is rejected. */
export const fakeVerifier: TokenVerifier = async (token) => {
  if (!token.startsWith("user:")) throw new Error("bad token");
  const subject = token.slice("user:".length);
  return { subject, profile: { email: `${subject}@Example.com`, name: `User ${subject}`, picture: null } };
};

export const auth = (clerkUserId = "user_1") => ({ Authorization: `Bearer user:${clerkUserId}` });

/** A resolver that never touches the database (for HTTP tests without PostgreSQL). */
export const memoryUsers = {
  async resolve(clerkUserId: string): Promise<User> {
    return {
      id: "00000000-0000-4000-8000-000000000001", clerkUserId, email: `${clerkUserId}@example.com`,
      displayName: `User ${clerkUserId}`, avatarUrl: null, lastSignedInAt: null, createdAt: new Date(0), updatedAt: new Date(0),
    };
  },
};

export class FakeGoogleAccounts implements GoogleAccounts {
  configured = true;
  account: GoogleAccount | null = {
    email: "me@gmail.com", approvedScopes: new Set([GMAIL_SEND_SCOPE, DRIVE_FILE_SCOPE]),
  };
  token: GoogleAccessToken | null = { value: "google-token", scopes: new Set([GMAIL_SEND_SCOPE, DRIVE_FILE_SCOPE]) };

  async findGoogleAccount() {
    return this.account;
  }

  async findAccessToken() {
    return this.token;
  }
}

export class FakeGmail implements GmailSender {
  sent: { message: string }[] = [];
  fail: Error | null = null;

  async send(_token: GoogleAccessToken, message: string): Promise<SentMessage> {
    if (this.fail) throw this.fail;
    this.sent.push({ message });
    return { messageId: `msg-${this.sent.length}`, threadId: "thread-1" };
  }
}

/** An in-memory Drive that only knows files this fake created. */
export class FakeDrive implements DriveClient {
  files = new Map<string, DriveFile & { content?: Buffer }>();
  uploads = 0;
  private next = 1;

  private matches(file: DriveFile, query: string) {
    if (file.trashed) return false;
    const marker = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(query);
    if (marker && file.appProperties?.[marker[1]!] !== marker[2]) return false;
    const parent = /^'([^']+)' in parents/.exec(query);
    if (parent && !file.parents?.includes(parent[1]!)) return false;
    if (query.includes("mimeType = 'application/vnd.google-apps.folder'") && file.mimeType !== "application/vnd.google-apps.folder") {
      return false;
    }
    return true;
  }

  async list(_token: string, query: string) {
    return [...this.files.values()].filter((file) => this.matches(file, query));
  }

  async get(_token: string, fileId: string) {
    const file = this.files.get(fileId);
    if (!file) throw new DriveApiError(404, null);
    return file;
  }

  async createFolder(_token: string, name: string, appProperties: Record<string, string>) {
    const file: DriveFile = { id: `folder${this.next++}`, name, mimeType: "application/vnd.google-apps.folder", appProperties };
    this.files.set(file.id, file);
    return file;
  }

  async upload(_token: string, name: string, parentId: string | null, mimeType: string,
    appProperties: Record<string, string>, content: Uint8Array) {
    this.uploads++;
    const file = { id: `file${this.next++}`, name, mimeType, appProperties, parents: parentId ? [parentId] : [],
      size: String(content.length), webViewLink: `https://drive.google.com/file/d/x/view`, content: Buffer.from(content) };
    this.files.set(file.id, file);
    return file;
  }

  async update(_token: string, fileId: string, changes: Record<string, unknown>) {
    const file = this.files.get(fileId);
    if (!file) throw new DriveApiError(404, null);
    Object.assign(file, changes);
    return file;
  }

  async download(_token: string, fileId: string) {
    return this.files.get(fileId)?.content ?? Buffer.alloc(0);
  }
}

/** Pretends to print: one page per 4 visible sections; the last document is kept for assertions. */
export class FakePdf implements PdfRenderer {
  lastDoc: Doc | null = null;

  async render(doc: Doc): Promise<RenderedPdf> {
    this.lastDoc = doc;
    const sections = doc.sections.filter((s) => s.visible).length;
    return { bytes: Buffer.from("%PDF-1.7\n% fake\n"), pages: Math.max(1, Math.ceil(sections / 4)) };
  }

  async close() {}
}

export type TestApp = ReturnType<typeof createApp> & {
  google: FakeGoogleAccounts;
  gmail: FakeGmail;
  drive: FakeDrive;
  pdf: FakePdf;
};

export function buildApp(db: Db, overrides: Partial<AppDependencies> = {}): TestApp {
  const google = new FakeGoogleAccounts();
  const gmail = new FakeGmail();
  const drive = new FakeDrive();
  const pdf = new FakePdf();
  const app = createApp({
    config: testConfig(),
    db,
    verifyToken: fakeVerifier,
    googleAccounts: google,
    gmailSender: gmail,
    driveClient: drive,
    pdf,
    boardFetchers: { GREENHOUSE: async () => [] },
    ...overrides,
  });
  return { ...app, google, gmail, drive, pdf };
}

/** A Prisma client that fails loudly on any use: for tests that must not touch PostgreSQL. */
export const noDb = new Proxy({}, {
  get: () => () => {
    throw new Error("This test must not use the database");
  },
}) as Db;

/**
 * The test database with the schema of prisma/migrations/0_init (created when missing), emptied.
 * Only call when TEST_DATABASE_URL is set.
 */
export async function testDb(): Promise<Db> {
  const db = createDb(TEST_DATABASE_URL!);
  // Each migration with a table it creates: applied when that table is missing
  const migrations: [string, string][] = [["0_init", "users"], ["1_user_fields", "user_fields"]];
  for (const [name, table] of migrations) {
    const [{ exists }] = await db.$queryRawUnsafe<{ exists: boolean }[]>(
      `select to_regclass('public.${table}') is not null as exists`);
    if (exists) continue;
    const sql = readFileSync(path.resolve(`prisma/migrations/${name}/migration.sql`), "utf8")
      .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      await db.$executeRawUnsafe(statement);
    }
  }
  await resetDb(db);
  return db;
}

export async function resetDb(db: Db) {
  await db.$executeRawUnsafe(
    "truncate users, jobs, email_templates, sent_emails, resumes, resume_versions, drive_settings, drive_documents cascade");
}

export const validResume = () => ({
  basics: { fullName: "Priya Sharma", email: "priya@example.com", links: [{ label: "GitHub", url: "github.com/priya" }] },
  sections: [
    { id: "summary", type: "text", title: "Summary", content: "Backend engineer who likes **reliable** systems." },
    {
      id: "experience", type: "entries", title: "Experience",
      entries: [{ id: "cred", title: "Software Engineer", subtitle: "CRED", startDate: "Jan 2022", current: true,
        bullets: ["Cut latency by *40%*", "Built [the API](https://example.com/api)"] }],
    },
    { id: "skills", type: "skills", title: "Skills", groups: [{ name: "Languages", keywords: ["Java", "TypeScript"] }] },
  ],
});
