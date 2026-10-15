import cors from "cors";
import express, { Router, type Express } from "express";

import { ApplicationEmailService, applicationEmailsRouter } from "./applications/application-emails.js";
import { currentUser, requireUser, type TokenVerifier } from "./auth/clerk.js";
import { clerkWebhookRouter } from "./auth/webhook.js";
import type { Config } from "./config.js";
import type { Db } from "./db/prisma.js";
import { DEFAULT_BOARDS, defaultFetchers, parseBoard, type BoardFetcher, type BoardProvider } from "./discovery/boards.js";
import { DiscoveryService, discoveryRouter } from "./discovery/discovery.js";
import { docsRouter } from "./docengine/docs-router.js";
import { DocEngine } from "./docengine/engine.js";
import type { PdfRenderer } from "./docengine/pdf.js";
import { DocPresets } from "./docengine/presets.js";
import { DriveService, driveRouter } from "./drive/drive.js";
import type { DriveClient } from "./drive/google-drive.js";
import { GmailService, gmailRouter, type GmailSender } from "./gmail/gmail.js";
import type { GoogleAccounts } from "./gmail/google-accounts.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { requestLogger } from "./http/request-logger.js";
import { JobService, jobsRouter } from "./jobs/jobs.js";
import { ResumeDocuments, resumeFileName, ResumeService, resumesRouter } from "./resumes/resumes.js";
import { TemplateService, templatesRouter } from "./templates/templates.js";
import { fillFields, UserFieldService, userFieldsRouter } from "./users/fields.js";
import { toMeResponse, UserService } from "./users/users.js";

/*
 * The HTTP API under /api/v1. Every route needs a valid Clerk session token except GET /health and the Clerk webhook
 * (which proves itself with a Svix signature). Stateless: no sessions or cookies, so CSRF protection isn't needed.
 * Outside services (Clerk, Google, job boards, Chromium) come in as dependencies so tests can replace them.
 */

export type AppDependencies = {
  config: Config;
  db: Db;
  verifyToken: TokenVerifier;
  googleAccounts: GoogleAccounts;
  gmailSender: GmailSender;
  driveClient: DriveClient;
  pdf: PdfRenderer;
  boardFetchers?: Partial<Record<BoardProvider, BoardFetcher>>;
  /** Saved details ({{github}} …); defaults to the user_fields table (tests can skip the database) */
  userFields?: UserFieldService;
  /** Looks up the signed-in user; defaults to the users table (tests can skip the database) */
  userResolver?: Pick<UserService, "resolve">;
  now?: () => Date;
};

export type App = { app: Express; engine: DocEngine };

export function createApp(deps: AppDependencies): App {
  const { config, db } = deps;
  const now = deps.now ?? (() => new Date());

  const users = new UserService(db);
  const jobs = new JobService(db);
  const userFields = deps.userFields ?? new UserFieldService(db);
  const templates = new TemplateService(db, userFields);
  const gmail = new GmailService(deps.googleAccounts, deps.gmailSender);
  const boards = (config.discoveryBoards.length > 0 ? config.discoveryBoards : DEFAULT_BOARDS).map(parseBoard);
  const discovery = new DiscoveryService(boards, deps.boardFetchers ?? defaultFetchers(), undefined, now);
  const engine = new DocEngine(new DocPresets(), deps.pdf);
  const drive = new DriveService(db, deps.googleAccounts, deps.driveClient);
  const resumeDocuments = new ResumeDocuments(engine);
  const resumes = new ResumeService(db, resumeDocuments, config.resumeVersionsEnabled);
  // A saved resume as the PDF attached to an application email: its document (or form), saved details filled in
  const resumePdf = async (user: { id: string }, resumeId: string) => {
    const resume = await resumes.get(user.id, resumeId);
    const document = resume.document ?? resumeDocuments.toDocument(resume.templateId, resume.pageSize, resume.data);
    const pdf = await resumeDocuments.renderDocumentPdf(await fillFields(userFields, user.id, document));
    // "<Name> - Resume.pdf", the name read from what's printed (the form copy of a document can be stale)
    const named = resume.document ? resumeDocuments.toForm(resume.document).data : resume.data;
    return { fileName: resumeFileName(null, named), content: pdf.bytes };
  };
  const applicationEmails = new ApplicationEmailService(db, jobs, templates, gmail, now, resumePdf);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.set("json spaces", 0);

  app.use(requestLogger);

  // CORS for calls from the frontend's origin. The Clerk token travels in the Authorization header; no cookies.
  app.use("/api", cors({
    origin: config.corsOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // Lets the browser read the suggested file name of downloads and the page count
    exposedHeaders: ["Content-Disposition", "X-Document-Pages"],
    credentials: false,
  }));

  const api = Router();

  api.get("/health", (_req, res) => {
    res.json({ status: "UP", service: "careerpilot-server", timestamp: new Date() });
  });

  // Raw body: the Svix signature covers the exact bytes Clerk sent
  api.use("/webhooks/clerk", clerkWebhookRouter(config.clerk.webhookSecret, users));

  // Everything below: JSON bodies up to MAX_REQUEST_BYTES (413 REQUEST_TOO_LARGE above), signed-in users only
  api.use(express.json({ limit: config.maxRequestBytes, type: ["application/json", "application/*+json"] }));
  api.use(requireUser(deps.verifyToken, deps.userResolver ?? users));

  api.get("/me", (_req, res) => {
    res.json(toMeResponse(currentUser(res)));
  });
  api.use("/me/fields", userFieldsRouter(userFields));
  api.use("/jobs/:jobId/emails", applicationEmailsRouter(applicationEmails));
  api.use("/jobs", jobsRouter(jobs));
  api.use("/email-templates", templatesRouter(templates));
  api.use("/gmail", gmailRouter(gmail));
  api.use("/discover", discoveryRouter(discovery));
  api.use("/docs", docsRouter(engine, userFields));
  api.use("/resumes", resumesRouter(resumes, resumeDocuments, drive, userFields));
  api.use("/drive", driveRouter(drive));

  app.use("/api/v1", api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, engine };
}
