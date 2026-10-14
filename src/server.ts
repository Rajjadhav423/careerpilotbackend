import { createApp } from "./app.js";
import { clerkTokenVerifier } from "./auth/clerk.js";
import { describeConfig, loadConfig } from "./config.js";
import { createDb } from "./db/prisma.js";
import { ReactPdfRenderer } from "./docengine/pdf.js";
import { GoogleDriveClient } from "./drive/google-drive.js";
import { GmailApiClient } from "./gmail/gmail.js";
import { ClerkGoogleAccounts } from "./gmail/google-accounts.js";

/* Starts the API: loads settings, connects to PostgreSQL, then listens on PORT. Migrations: npm run migrate. */

const config = loadConfig();

const db = createDb(config.databaseUrl);
await db.$connect();

const pdf = new ReactPdfRenderer(config.pdf);
const { app, engine } = createApp({
  config,
  db,
  verifyToken: clerkTokenVerifier(config.clerk),
  googleAccounts: new ClerkGoogleAccounts(config.clerk.secretKey),
  gmailSender: new GmailApiClient(),
  driveClient: new GoogleDriveClient(),
  pdf,
});

const server = app.listen(config.port, () => {
  console.info(`CareerPilot API listening on port ${config.port}`);
  engine.warmUp();
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.info(`${signal} received, shutting down`);
  server.close();
  await pdf.close();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
