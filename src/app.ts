import express from "express";

import { createApp } from "./create-app.js";
import { clerkTokenVerifier } from "./auth/clerk.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/prisma.js";
import { ReactPdfRenderer } from "./docengine/pdf.js";
import { GoogleDriveClient } from "./drive/google-drive.js";
import { GmailApiClient } from "./gmail/gmail.js";
import { ClerkGoogleAccounts } from "./gmail/google-accounts.js";

/*
 * Entry point for serverless hosting (Vercel): the Express app as the default export, built once per instance and
 * reused across requests. Vercel handles listening; migrations run separately (npm run migrate).
 * Vercel only accepts an entry file that imports express itself, hence the outer app wrapping ours.
 * Local development and long-running hosts use src/server.ts instead.
 */

const config = loadConfig();

const { app: api } = createApp({
  config,
  db: createDb(config.databaseUrl),
  verifyToken: clerkTokenVerifier(config.clerk),
  googleAccounts: new ClerkGoogleAccounts(config.clerk.secretKey),
  gmailSender: new GmailApiClient(),
  driveClient: new GoogleDriveClient(),
  pdf: new ReactPdfRenderer(config.pdf),
});

const app = express();
app.disable("x-powered-by");
app.use(api);

export default app;
