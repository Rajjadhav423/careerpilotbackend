import request from "supertest";
import { describe, expect, it } from "vitest";

import { SvixVerifier } from "../../src/auth/svix.js";
import { auth, buildApp, memoryUsers, noDb, testConfig, validResume } from "../helpers.js";

/* The HTTP layer without PostgreSQL: users come from memory and outside services are fakes. */

const app = (overrides: Parameters<typeof buildApp>[1] = {}) =>
  buildApp(noDb, {
    userResolver: memoryUsers,
    boardFetchers: {
      GREENHOUSE: async () => [{
        id: "greenhouse-acme-1", title: "Backend Engineer", company: "Acme", location: "Remote", department: null,
        workplaceType: "REMOTE", url: "https://jobs.example.com/1", postedAt: null, source: "Greenhouse", techRole: null,
      }],
    },
    ...overrides,
  });

const doc = (nodes: unknown[]) => ({ schemaVersion: 3, document: "resume", meta: { title: "My CV" }, sections: [{ id: "a", nodes }] });

describe("basics", () => {
  it("serves health without signing in", async () => {
    const res = await request(app().app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "UP", service: "careerpilot-server" });
  });

  it("requires a valid Clerk token everywhere else", async () => {
    const { app: server } = app();
    const missing = await request(server).get("/api/v1/jobs");
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    expect(missing.headers["content-type"]).toMatch(/application\/problem\+json/);
    const bad = await request(server).get("/api/v1/jobs").set("Authorization", "Bearer forged");
    expect(bad.status).toBe(401);
  });

  it("returns the signed-in user", async () => {
    const res = await request(app().app).get("/api/v1/me").set(auth("user_9"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "user_9@example.com", displayName: "User user_9" });
  });

  it("answers unknown routes and ids with 404", async () => {
    const { app: server } = app();
    expect((await request(server).get("/api/v1/nope").set(auth())).body.code).toBe("NOT_FOUND");
    expect((await request(server).get("/api/v1/jobs/not-a-uuid").set(auth())).body.code).toBe("JOB_NOT_FOUND");
  });

  it("allows the frontend origin through CORS", async () => {
    const { app: server } = app();
    const preflight = await request(server).options("/api/v1/jobs")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "PATCH")
      .set("Access-Control-Request-Headers", "authorization,content-type");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    const other = await request(server).get("/api/v1/health").set("Origin", "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const exposed = await request(server).get("/api/v1/health").set("Origin", "http://localhost:3000");
    expect(exposed.headers["access-control-expose-headers"]).toBe("Content-Disposition,X-Document-Pages");
  });

  it("rejects malformed and oversized bodies", async () => {
    const malformed = await request(app().app).post("/api/v1/jobs").set(auth())
      .set("Content-Type", "application/json").send("{bad");
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("MALFORMED_JSON");

    const small = app({ config: testConfig({ maxRequestBytes: 100 }) });
    const large = await request(small.app).post("/api/v1/jobs").set(auth()).send({ notes: "x".repeat(500) });
    expect(large.status).toBe(413);
    expect(large.body.code).toBe("REQUEST_TOO_LARGE");
  });
});

describe("validation errors", () => {
  it("reports field errors like the Spring backend", async () => {
    const res = await request(app().app).post("/api/v1/jobs").set(auth())
      .send({ title: " ", company: "Acme", jobUrl: "ftp://x", workMode: "SPACE" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ title: "Validation failed", code: "VALIDATION_FAILED" });
    expect(res.body.errors).toMatchObject({
      title: "must not be blank",
      jobUrl: "must be a valid http(s) URL",
      workMode: "must be one of ONSITE, HYBRID, REMOTE",
    });
  });
});

describe("docEngine API", () => {
  it("serves the rules and presets", async () => {
    const { app: server } = app();
    const rules = await request(server).get("/api/v1/docs/rules").set(auth());
    expect(rules.status).toBe(200);
    expect(rules.headers["content-type"]).toMatch(/text\/markdown/);
    expect(rules.text.length).toBeGreaterThan(100);
    const presets = await request(server).get("/api/v1/docs/presets").set(auth());
    expect(presets.body.map((p: { id: string }) => p.id)).toEqual(["classic", "modern"]);
  });

  it("validates strictly and repairs leniently", async () => {
    const { app: server } = app();
    const broken = doc([{ tag: "p", text: "Hi", bogus: 1 }, { tag: "script", text: "x" }]);
    const strict = await request(server).post("/api/v1/docs/validate").set(auth()).send({ document: broken });
    expect(strict.body).toMatchObject({ valid: false, pages: null });
    expect(strict.body.errors.length).toBe(2);
    const lenient = await request(server).post("/api/v1/docs/validate").set(auth()).send({ document: broken, mode: "lenient" });
    expect(lenient.body).toMatchObject({ valid: true, pages: 1, errors: [] });
    expect(lenient.body.document.sections[0].nodes).toEqual([{ tag: "p", text: "Hi" }]);
  });

  it("renders a PDF download", async () => {
    const res = await request(app().app).post("/api/v1/docs/render/pdf").set(auth())
      .send({ document: doc([{ tag: "p", text: "Hi" }]), fileName: "Résumé" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["x-document-pages"]).toBe("1");
    expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9.pdf");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("refuses documents longer than maxPages", async () => {
    const long = { schemaVersion: 3, document: "resume", page: { maxPages: 1 },
      sections: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, nodes: [{ tag: "p", text: "x" }] })) };
    const res = await request(app().app).post("/api/v1/docs/render/pdf").set(auth()).send({ document: long });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "DOCUMENT_TOO_LONG", pages: 2, maxPages: 1 });
  });

  it("renders safe HTML with a strict CSP", async () => {
    const res = await request(app().app).post("/api/v1/docs/render/html").set(auth())
      .send({ document: doc([{ tag: "p", text: "<img src=x onerror=alert(1)>" }]) });
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("returns the PDF for the in-browser page preview", async () => {
    const res = await request(app().app).post("/api/v1/docs/render/pages").set(auth())
      .send({ document: doc([{ tag: "p", text: "Hi" }]) });
    expect(res.body).toEqual({ pageCount: 1, pdf: Buffer.from("%PDF-1.7\n% fake\n").toString("base64") });
  });

  it("explains bad requests", async () => {
    const { app: server } = app();
    const missing = await request(server).post("/api/v1/docs/render/pdf").set(auth()).send({});
    expect(missing.body.code).toBe("DOCUMENT_MISSING");
    const mode = await request(server).post("/api/v1/docs/render/pdf").set(auth()).send({ document: doc([]), mode: "loose" });
    expect(mode.body.code).toBe("MODE_INVALID");
    const invalid = await request(server).post("/api/v1/docs/render/pdf").set(auth())
      .send({ document: doc([{ tag: "iframe" }]) });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: "DOCUMENT_INVALID", issues: [{ path: "/sections/0/nodes/0/tag", code: "TAG_BLOCKED" }] });
  });
});

describe("resume rendering", () => {
  it("lists templates and serves the JSON schema", async () => {
    const { app: server } = app();
    const templates = await request(server).get("/api/v1/resumes/templates").set(auth());
    expect(templates.body.map((t: { id: string }) => t.id)).toEqual(["classic", "modern"]);
    const schema = await request(server).get("/api/v1/resumes/schema").set(auth());
    expect(schema.headers["content-type"]).toMatch(/application\/schema\+json/);
  });

  it("previews unsaved resume data as HTML", async () => {
    const res = await request(app().app).post("/api/v1/resumes/render/preview").set(auth()).send({ data: validResume() });
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.text).toContain("Priya Sharma");
    expect(res.text).toContain("<strong>reliable</strong>");
  });

  it("downloads a PDF named after the person", async () => {
    const res = await request(app().app).post("/api/v1/resumes/render/pdf").set(auth()).send({ data: validResume() });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="Priya Sharma - Resume.pdf"');
  });

  it("validates resume data", async () => {
    const { app: server } = app();
    const missing = await request(server).post("/api/v1/resumes/render/pdf").set(auth()).send({});
    expect(missing.body.errors).toMatchObject({ data: "is required" });
    const res = await request(server).post("/api/v1/resumes/render/pdf").set(auth())
      .send({ data: { basics: { fullName: "" } }, templateId: "classic" });
    expect(res.status).toBe(400);
    expect(res.body.errors).toMatchObject({ "data.basics.fullName": "is required" });
    const template = await request(server).post("/api/v1/resumes/render/pdf").set(auth())
      .send({ data: validResume(), templateId: "fancy" });
    expect(template.body.code).toBe("UNKNOWN_TEMPLATE");
  });

  it("converts form data to a document", async () => {
    const res = await request(app().app).post("/api/v1/resumes/document").set(auth()).send({ data: validResume(), pageSize: "LETTER" });
    expect(res.body).toMatchObject({ schemaVersion: 3, document: "resume", preset: "classic", page: { size: "LETTER" } });
  });

  it("normalizes imported JSON in either format", async () => {
    const { app: server } = app();
    const legacy = await request(server).post("/api/v1/resumes/normalize").set(auth())
      .send({ basics: { fullName: "Asha" }, summary: "Hi", skills: [{ name: "Languages", items: ["Go"] }] });
    expect(legacy.status).toBe(200);
    expect(legacy.body.sections.map((s: { id: string }) => s.id)).toEqual(["summary", "skills"]);
    const invalid = await request(server).post("/api/v1/resumes/normalize").set(auth()).send({ basics: {} });
    expect(invalid.body.errors).toMatchObject({ "data.basics.fullName": "is required" });
  });
});

describe("discovery, Gmail and templates without a database", () => {
  it("searches job boards", async () => {
    const { app: server } = app();
    const res = await request(server).get("/api/v1/discover/jobs?q=backend&location=remote").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, roleCounts: { BACKEND: 1 } });
    expect(res.body.jobs[0]).toMatchObject({ id: "greenhouse-acme-1", techRole: "BACKEND" });
    expect((await request(server).get("/api/v1/discover/jobs?role=WIZARD").set(auth())).status).toBe(400);
  });

  it("reports Gmail status", async () => {
    const res = await request(app().app).get("/api/v1/gmail/status").set(auth());
    expect(res.body).toEqual({ configured: true, connected: true, canSend: true, googleEmail: "me@gmail.com" });
  });

  it("lists merge fields and previews templates", async () => {
    const { app: server } = app();
    const fields = await request(server).get("/api/v1/email-templates/merge-fields").set(auth());
    expect(fields.body).toHaveLength(9);
    expect(fields.body[0]).toMatchObject({ key: "candidate_name", placeholder: "{{candidate_name}}" });
    const preview = await request(server).post("/api/v1/email-templates/preview").set(auth())
      .send({ subject: "{{job_title}} at {{company_name}}", body: "Hi {{bogus}}" });
    expect(preview.body).toEqual({ subject: "Backend Engineer at Northwind Labs", body: "Hi {{bogus}}", unknownPlaceholders: ["{{bogus}}"] });
  });
});

describe("Clerk webhook", () => {
  const secret = `whsec_${Buffer.from("a-test-signing-key-32-bytes-long").toString("base64")}`;

  it("is off without a signing secret", async () => {
    const res = await request(app().app).post("/api/v1/webhooks/clerk").send({ type: "user.created" });
    expect(res.status).toBe(503);
  });

  it("checks the Svix signature", async () => {
    const { app: server } = app({ config: testConfig({ clerk: { ...testConfig().clerk, webhookSecret: secret } }) });
    const body = JSON.stringify({ type: "email.created", data: { id: "x" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const forged = await request(server).post("/api/v1/webhooks/clerk")
      .set({ "Content-Type": "application/json", "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": "v1,AAAA" })
      .send(body);
    expect(forged.status).toBe(401);
    const signature = new SvixVerifier(secret).sign("msg_1", timestamp, body);
    const signed = await request(server).post("/api/v1/webhooks/clerk")
      .set({ "Content-Type": "application/json", "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": signature })
      .send(body);
    expect(signed.status).toBe(204);
  });
});
