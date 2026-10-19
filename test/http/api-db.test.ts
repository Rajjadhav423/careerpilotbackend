import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SvixVerifier } from "../../src/auth/svix.js";
import type { Db } from "../../src/db/prisma.js";
import { auth, buildApp, resetDb, TEST_DATABASE_URL, testConfig, testDb, validResume, type TestApp } from "../helpers.js";

/*
 * End to end against PostgreSQL. Set TEST_DATABASE_URL to an EMPTY database you can wipe (never production):
 * every test truncates all tables.
 */

describe.skipIf(!TEST_DATABASE_URL)("API with PostgreSQL", () => {
  let db: Db;
  let t: TestApp;

  beforeAll(async () => {
    db = await testDb();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(db);
    t = buildApp(db);
  });

  const api = () => request(t.app);

  async function createJob(body: Record<string, unknown> = {}, user = "user_1") {
    const res = await api().post("/api/v1/jobs").set(auth(user)).send({ title: "Backend Engineer", company: "Acme", ...body });
    return res;
  }

  describe("migrations and users", () => {
    it("has the schema", async () => {
      expect(await db.user.count()).toBe(0);
      expect(await db.driveDocument.count()).toBe(0);
    });

    it("creates the user on first request with the token's profile", async () => {
      const res = await api().get("/api/v1/me").set(auth("user_42"));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email: "user_42@example.com", displayName: "User user_42", lastSignedInAt: null });
      const again = await api().get("/api/v1/me").set(auth("user_42"));
      expect(again.body.id).toBe(res.body.id);
    });

    it("follows Clerk webhooks", async () => {
      const secret = `whsec_${Buffer.from("a-test-signing-key-32-bytes-long").toString("base64")}`;
      t = buildApp(db, { config: testConfig({ clerk: { ...testConfig().clerk, webhookSecret: secret } }) });
      const send = (event: unknown) => {
        const body = JSON.stringify(event);
        const timestamp = String(Math.floor(Date.now() / 1000));
        return api().post("/api/v1/webhooks/clerk").set({
          "Content-Type": "application/json", "svix-id": "msg", "svix-timestamp": timestamp,
          "svix-signature": new SvixVerifier(secret).sign("msg", timestamp, body),
        }).send(body);
      };
      expect((await send({ type: "user.created", data: { id: "user_7", first_name: "Asha", last_name: "K",
        primary_email_address_id: "e1", email_addresses: [{ id: "e1", email_address: "Asha@Example.com" }] } })).status).toBe(204);
      expect((await send({ type: "session.created", data: { id: "sess_1", user_id: "user_7", created_at: 1_760_000_000_000 } })).status)
        .toBe(204);
      const user = await db.user.findUniqueOrThrow({ where: { clerkUserId: "user_7" } });
      expect(user).toMatchObject({ email: "asha@example.com", displayName: "Asha K" });
      expect(user.lastSignedInAt?.getTime()).toBe(1_760_000_000_000);

      await send({ type: "user.deleted", data: { id: "user_7" } });
      expect(await db.user.count({ where: { clerkUserId: "user_7" } })).toBe(0);
    });
  });

  describe("jobs", () => {
    it("creates, reads, updates and archives jobs", async () => {
      const created = await createJob({ location: " Bengaluru ", workMode: "HYBRID", jobUrl: "https://jobs.example.com/1", notes: "" });
      expect(created.status).toBe(201);
      expect(created.headers.location).toBe(`/api/v1/jobs/${created.body.id}`);
      expect(created.body).toMatchObject({ status: "SAVED", source: "MANUAL", location: "Bengaluru", notes: null, archived: false });

      const id = created.body.id;
      const moved = await api().patch(`/api/v1/jobs/${id}`).set(auth()).send({ status: "INTERVIEW", location: "" });
      expect(moved.body).toMatchObject({ status: "INTERVIEW", location: null, title: "Backend Engineer" });

      expect((await api().patch(`/api/v1/jobs/${id}`).set(auth()).send({ title: "  " })).body.code).toBe("VALIDATION_FAILED");

      await createJob({ title: "Second" });
      const list = await api().get("/api/v1/jobs").set(auth());
      expect(list.body.map((j: { title: string }) => j.title)).toEqual(["Second", "Backend Engineer"]);
      expect((await api().get("/api/v1/jobs?status=INTERVIEW").set(auth())).body).toHaveLength(1);
      expect((await api().get("/api/v1/jobs?status=NOPE").set(auth())).status).toBe(400);

      await api().patch(`/api/v1/jobs/${id}`).set(auth()).send({ archived: true });
      expect((await api().get("/api/v1/jobs").set(auth())).body).toHaveLength(1);
      expect((await api().get("/api/v1/jobs?archived=true").set(auth())).body[0].id).toBe(id);
    });

    it("saves a Find-jobs posting only once", async () => {
      const first = await createJob({ source: "greenhouse", externalId: "greenhouse-acme-1" });
      expect(first.status).toBe(201);
      expect(first.body.source).toBe("GREENHOUSE");
      const second = await createJob({ source: "greenhouse", externalId: "greenhouse-acme-1" });
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
    });

    it("hides other users' jobs", async () => {
      const job = await createJob();
      const res = await api().get(`/api/v1/jobs/${job.body.id}`).set(auth("someone_else"));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("JOB_NOT_FOUND");
      expect((await api().get("/api/v1/jobs").set(auth("someone_else"))).body).toEqual([]);
    });
  });

  describe("email templates", () => {
    const template = (body: Record<string, unknown> = {}) => ({
      name: "Default", subject: "Application for {{job_title}}", body: "Hi,\n{{candidate_name}}", isDefault: true, ...body,
    });

    it("keeps one default template", async () => {
      const first = await api().post("/api/v1/email-templates").set(auth()).send(template());
      expect(first.status).toBe(201);
      const second = await api().post("/api/v1/email-templates").set(auth()).send(template({ name: "Another" }));
      const list = await api().get("/api/v1/email-templates").set(auth());
      expect(list.body.map((x: { id: string; isDefault: boolean }) => [x.id, x.isDefault])).toEqual([
        [second.body.id, true], [first.body.id, false],
      ]);
    });

    it("refuses unknown placeholders and multi-line subjects", async () => {
      const unknown = await api().post("/api/v1/email-templates").set(auth()).send(template({ body: "{{salary}}" }));
      expect(unknown.body.code).toBe("UNKNOWN_PLACEHOLDERS");
      const injected = await api().post("/api/v1/email-templates").set(auth()).send(template({ subject: "Hi\nBcc: x@y.com" }));
      expect(injected.body.errors).toMatchObject({ subject: "must be a single line" });
    });

    it("duplicates, updates and deletes", async () => {
      const original = await api().post("/api/v1/email-templates").set(auth()).send(template());
      const copy = await api().post(`/api/v1/email-templates/${original.body.id}/duplicate`).set(auth());
      expect(copy.status).toBe(201);
      expect(copy.body).toMatchObject({ name: "Copy of Default", isDefault: false });
      const updated = await api().put(`/api/v1/email-templates/${copy.body.id}`).set(auth()).send(template({ name: "Renamed", isDefault: false }));
      expect(updated.body.name).toBe("Renamed");
      expect((await api().delete(`/api/v1/email-templates/${copy.body.id}`).set(auth())).status).toBe(204);
      expect((await api().get(`/api/v1/email-templates/${copy.body.id}`).set(auth())).body.code).toBe("TEMPLATE_NOT_FOUND");
    });
  });

  describe("application emails", () => {
    it("composes, sends and records an application", async () => {
      const job = await createJob({ jobUrl: "https://jobs.example.com/1" });
      await api().post("/api/v1/email-templates").set(auth()).send({
        name: "Default", subject: "{{job_title}} at {{company_name}}", body: "Hi, I'm {{candidate_name}}. CV: {{resume_url}}",
        isDefault: true,
      });
      const compose = await api().post(`/api/v1/jobs/${job.body.id}/emails/compose`).set(auth()).send({ timeZone: "Asia/Kolkata" });
      expect(compose.body).toMatchObject({
        subject: "Backend Engineer at Acme",
        body: "Hi, I'm User user_1. CV: {{resume_url}}",
        missingFields: [{ key: "resume_url", placeholder: "{{resume_url}}", label: "Resume link" }],
      });

      const email = { to: "hr@acme.com", subject: "Backend Engineer at Acme", body: "Hello" };
      expect((await api().post(`/api/v1/jobs/${job.body.id}/emails`).set(auth()).send(email)).body.code).toBe("CONFIRMATION_REQUIRED");
      const unresolved = await api().post(`/api/v1/jobs/${job.body.id}/emails`).set(auth())
        .send({ ...email, body: "CV: {{resume_url}}", confirmed: true });
      expect(unresolved.status).toBe(422);
      expect(t.gmail.sent).toHaveLength(0);

      const sent = await api().post(`/api/v1/jobs/${job.body.id}/emails`).set(auth()).send({ ...email, confirmed: true });
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({ jobStatus: "APPLIED" });
      expect(t.gmail.sent[0]!.message).toContain("To: hr@acme.com");

      const again = await api().post(`/api/v1/jobs/${job.body.id}/emails`).set(auth()).send({ ...email, confirmed: true });
      expect(again.body.appliedAt).toBe(sent.body.appliedAt);

      const history = await api().get(`/api/v1/jobs/${job.body.id}/emails`).set(auth());
      expect(history.body).toHaveLength(2);
      expect(history.body[0]).toMatchObject({ recipient: "hr@acme.com", subject: "Backend Engineer at Acme" });
    });

    it("records nothing when Gmail refuses", async () => {
      const job = await createJob();
      t.gmail.fail = new Error("boom");
      const res = await api().post(`/api/v1/jobs/${job.body.id}/emails`).set(auth())
        .send({ to: "hr@acme.com", subject: "Hi", body: "Hello", confirmed: true });
      expect(res.status).toBe(500);
      expect((await api().get(`/api/v1/jobs/${job.body.id}`).set(auth())).body.status).toBe("SAVED");
    });

    it("refuses bad recipients", async () => {
      const job = await createJob();
      const res = await api().post(`/api/v1/jobs/${job.body.id}/emails`).set(auth())
        .send({ to: "a@b.com, c@d.com", subject: "Hi", body: "x", confirmed: true });
      expect(res.body.errors).toMatchObject({ to: "must be a single valid email address" });
    });
  });

  describe("resumes", () => {
    const save = (body: Record<string, unknown> = {}, user = "user_1") =>
      api().post("/api/v1/resumes").set(auth(user)).send({ title: "Main", data: validResume(), ...body });

    it("saves, lists, updates and deletes resumes", async () => {
      const created = await save({ pageSize: "LETTER" });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ title: "Main", templateId: "classic", pageSize: "LETTER", document: null });
      expect(created.body.data.sections[1].entries[0].id).toBe("cred");

      const list = await api().get("/api/v1/resumes").set(auth());
      expect(list.body[0]).toMatchObject({ fullName: "Priya Sharma", pendingProposals: 0 });

      const data = validResume();
      data.basics.fullName = "Priya S.";
      const updated = await api().put(`/api/v1/resumes/${created.body.id}`).set(auth()).send({ title: "Main v2", templateId: "modern", data });
      expect(updated.body).toMatchObject({ title: "Main v2", templateId: "modern", pageSize: "A4" });
      expect(updated.body.data.basics.fullName).toBe("Priya S.");

      expect((await api().get(`/api/v1/resumes/${created.body.id}`).set(auth("other"))).status).toBe(404);
      expect((await api().delete(`/api/v1/resumes/${created.body.id}`).set(auth())).status).toBe(204);
      expect((await api().get(`/api/v1/resumes/${created.body.id}`).set(auth())).body.code).toBe("RESUME_NOT_FOUND");
    });

    it("keeps one AI copy per user, apart from the user's resumes", async () => {
      const mine = await save({ title: "Resume" });
      const first = await api().put("/api/v1/resumes/ai-copy").set(auth()).send({ title: "Resume", data: validResume() });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ title: "Resume", aiCopy: true });
      expect(first.body.id).not.toBe(mine.body.id);

      const data = validResume();
      data.basics.fullName = "Priya Tailored";
      const again = await api().put("/api/v1/resumes/ai-copy").set(auth()).send({ title: "Resume", data });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ id: first.body.id, aiCopy: true });
      expect(again.body.data.basics.fullName).toBe("Priya Tailored");

      const list = (await api().get("/api/v1/resumes").set(auth())).body as { id: string; aiCopy: boolean }[];
      expect(list.filter((r) => r.aiCopy).map((r) => r.id)).toEqual([first.body.id]);
      expect((await api().get(`/api/v1/resumes/${mine.body.id}`).set(auth())).body).toMatchObject({ aiCopy: false });

      const other = await api().put("/api/v1/resumes/ai-copy").set(auth("other")).send({ title: "Resume", data: validResume() });
      expect(other.status).toBe(201);
      expect(other.body.id).not.toBe(first.body.id);
    });

    it("stores a validated document", async () => {
      const document = (await api().post("/api/v1/resumes/document").set(auth()).send({ data: validResume() })).body;
      const created = await save({ document });
      expect(created.status).toBe(201);
      expect(created.body.document).toMatchObject({ schemaVersion: 3, preset: "classic" });
      const invalid = await save({ document: { schemaVersion: 3, document: "resume", sections: [{ id: "a", nodes: [{ tag: "img" }] }] } });
      expect(invalid.body.code).toBe("DOCUMENT_INVALID");
    });

    it("keeps version endpoints closed while versions are off", async () => {
      const created = await save();
      expect((await api().get(`/api/v1/resumes/${created.body.id}/versions`).set(auth())).body).toEqual([]);
      const proposal = await api().post(`/api/v1/resumes/${created.body.id}/versions`).set(auth()).send({ data: validResume() });
      expect(proposal.body.code).toBe("VERSIONS_DISABLED");
    });

    it("records history and reviews proposals when versions are on", async () => {
      t = buildApp(db, { config: testConfig({ resumeVersionsEnabled: true }) });
      const created = await save();
      const id = created.body.id;
      await api().put(`/api/v1/resumes/${id}`).set(auth()).send({ title: "Main", data: validResume() });

      const suggestion = validResume();
      suggestion.basics.fullName = "Priya Sharma (AI)";
      const proposal = await api().post(`/api/v1/resumes/${id}/versions`).set(auth()).send({ source: "AI", data: suggestion });
      expect(proposal.status).toBe(201);
      expect(proposal.body).toMatchObject({ number: 3, status: "PROPOSED", source: "AI", label: "AI suggestion" });

      const versions = await api().get(`/api/v1/resumes/${id}/versions`).set(auth());
      expect(versions.body.map((v: { number: number; status: string; changes: number | null }) => [v.number, v.status, v.changes]))
        .toEqual([[3, "PROPOSED", 1], [2, "SAVED", null], [1, "SAVED", null]]);
      expect((await api().get("/api/v1/resumes").set(auth())).body[0].pendingProposals).toBe(1);

      const diff = await api().get(`/api/v1/resumes/${id}/versions/${proposal.body.id}/diff`).set(auth());
      expect(diff.body.changes).toEqual([
        { kind: "CHANGED", where: "Basics", field: "name", before: "Priya Sharma", after: "Priya Sharma (AI)" },
      ]);

      const saved = versions.body[1].id;
      expect((await api().delete(`/api/v1/resumes/${id}/versions/${saved}`).set(auth())).body.code).toBe("NOT_A_PROPOSAL");

      const accepted = await api().post(`/api/v1/resumes/${id}/versions/${proposal.body.id}/accept`).set(auth());
      expect(accepted.body.data.basics.fullName).toBe("Priya Sharma (AI)");
      const after = await api().get(`/api/v1/resumes/${id}/versions`).set(auth());
      expect(after.body[0]).toMatchObject({ number: 3, status: "ACCEPTED" });

      const restored = await api().post(`/api/v1/resumes/${id}/versions/${saved}/accept`).set(auth());
      expect(restored.body.data.basics.fullName).toBe("Priya Sharma");
      const last = await api().get(`/api/v1/resumes/${id}/versions`).set(auth());
      expect(last.body[0]).toMatchObject({ number: 4, source: "RESTORE", label: "Restored version 2" });
    });
  });

  describe("Google Drive", () => {
    it("connects, uploads once per request id, renames and trashes", async () => {
      const status = await api().get("/api/v1/drive/status").set(auth());
      expect(status.body).toMatchObject({ configured: true, connected: true, permissionGranted: true, googleEmail: "me@gmail.com" });

      const requestId = "7f0c2a4e-3f43-4c55-9d4a-1c8b2f4e9a10";
      const upload = () => api().post("/api/v1/resumes/render/drive").set(auth()).send({ requestId, data: validResume() });
      const first = await upload();
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ name: "Priya Sharma - Resume.pdf", mimeType: "application/pdf" });
      const retry = await upload();
      expect(retry.body.id).toBe(first.body.id);
      expect(t.drive.uploads).toBe(1);
      expect(t.drive.shared.size).toBe(1);

      const folders = await api().get("/api/v1/drive/folders").set(auth());
      expect(folders.body).toEqual([{ id: first.body.folderId, name: "CareerPilot", selected: true }]);

      const second = await api().post("/api/v1/resumes/render/drive").set(auth())
        .send({ requestId: "0b9d7a3c-1111-4222-8333-944455556666", data: validResume() });
      expect(second.body.name).toBe("Priya Sharma - Resume (2).pdf");

      const listed = await api().get("/api/v1/drive/documents").set(auth());
      expect(listed.body).toHaveLength(2);

      const clash = await api().patch(`/api/v1/drive/documents/${second.body.id}`).set(auth()).send({ name: "Priya Sharma - Resume" });
      expect(clash.body.code).toBe("DRIVE_NAME_TAKEN");
      const renamed = await api().patch(`/api/v1/drive/documents/${second.body.id}`).set(auth()).send({ name: "Tailored" });
      expect(renamed.body.name).toBe("Tailored.pdf");

      const download = await api().get(`/api/v1/drive/documents/${second.body.id}/download`).set(auth());
      expect(download.headers["content-type"]).toBe("application/pdf");
      expect(download.headers["content-disposition"]).toContain('filename="Tailored.pdf"');

      expect((await api().delete(`/api/v1/drive/documents/${second.body.id}`).set(auth())).body.code).toBe("CONFIRMATION_REQUIRED");
      expect((await api().delete(`/api/v1/drive/documents/${second.body.id}?confirm=true`).set(auth())).status).toBe(204);
      expect((await api().get("/api/v1/drive/documents").set(auth())).body).toHaveLength(1);
    });

    it("switches Drive off and on", async () => {
      expect((await api().delete("/api/v1/drive/connection").set(auth())).status).toBe(204);
      expect((await api().get("/api/v1/drive/status").set(auth())).body.connected).toBe(false);
      expect((await api().get("/api/v1/drive/documents").set(auth())).body.code).toBe("DRIVE_NOT_CONNECTED");
      expect((await api().post("/api/v1/drive/connect").set(auth())).body).toEqual({
        needsGoogleConsent: false, scope: "https://www.googleapis.com/auth/drive.file",
      });
      expect((await api().get("/api/v1/drive/status").set(auth())).body.connected).toBe(true);
    });

    it("refuses another user's resume id", async () => {
      const other = await api().post("/api/v1/resumes").set(auth("other")).send({ title: "x", data: validResume() });
      const res = await api().post("/api/v1/resumes/render/drive").set(auth()).send({
        requestId: "7f0c2a4e-3f43-4c55-9d4a-1c8b2f4e9a10", data: validResume(), resumeId: other.body.id,
      });
      expect(res.body.code).toBe("RESUME_NOT_FOUND");
    });
  });
});
