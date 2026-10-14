import { randomUUID } from "node:crypto";

import type { DriveDocument as DocumentModel } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth/clerk.js";
import type { Db, Tx } from "../db/prisma.js";
import { attachment } from "../docengine/engine.js";
import { DRIVE_FILE_SCOPE, type GoogleAccount, type GoogleAccounts } from "../gmail/google-accounts.js";
import { ApiError } from "../http/errors.js";
import { body, flag, requiredText, uuidParam } from "../http/validate.js";
import type { User } from "../users/users.js";
import {
  appProperty, DriveApiError, firstParent, FOLDER_MIME_TYPE, sizeBytes, type DriveClient, type DriveFile,
} from "./google-drive.js";

/*
 * The signed-in user's Google Drive settings and the documents CareerPilot stored there. Google access comes from
 * Clerk (like Gmail): the browser asks Clerk to re-authorize Google with drive.file, and Clerk stores and refreshes
 * the token. CareerPilot stores no Google tokens. "Disconnect" switches Drive off in CareerPilot and forgets the
 * folder and document list; Google's permission stays on the account.
 */

export const APP_KEY = "careerpilot";
export const FOLDER_MARKER = "folder";
export const DOCUMENT_MARKER = "document";
export const REQUEST_KEY = "careerpilotRequest";
export const DEFAULT_FOLDER_NAME = "CareerPilot";
const PDF = "application/pdf";
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// ---- errors: clear, safe messages (no Google error text is passed through) ----

export const driveErrors = {
  notConfigured: () => new ApiError(503, "DRIVE_NOT_CONFIGURED", "Google Drive isn't set up on this server yet."),
  notConnected: () => new ApiError(409, "DRIVE_NOT_CONNECTED", "Connect Google Drive first."),
  permissionMissing: () => new ApiError(409, "DRIVE_PERMISSION_MISSING",
    "CareerPilot doesn't have permission to save files to your Google Drive yet. Connect Google Drive to allow it."),
  reconnectRequired: () => new ApiError(409, "DRIVE_RECONNECT_REQUIRED",
    "CareerPilot no longer has access to your Google Drive. Connect Google Drive again to continue."),
  documentNotFound: () => new ApiError(404, "DRIVE_DOCUMENT_NOT_FOUND",
    "That document wasn't found. It may have been deleted in Google Drive."),
  folderNotFound: () => new ApiError(404, "DRIVE_FOLDER_NOT_FOUND",
    "That folder wasn't found. Pick or create a CareerPilot folder."),
  from(error: DriveApiError): ApiError {
    switch (error.status) {
      case 401:
        return driveErrors.reconnectRequired();
      case 403:
        if (error.reason === "storageQuotaExceeded") {
          return new ApiError(409, "DRIVE_STORAGE_FULL", "Your Google Drive is full. Free up space and try again.");
        }
        return error.reason === "insufficientPermissions" ? driveErrors.permissionMissing()
          : new ApiError(409, "DRIVE_PERMISSION_DENIED", "Google Drive refused this action. Reconnect Google Drive and try again.");
      case 404:
        return driveErrors.documentNotFound();
      case 413:
        return new ApiError(422, "DRIVE_FILE_TOO_LARGE", "That file is too large to open here. Open it in Google Drive instead.");
      default:
        return new ApiError(502, "DRIVE_UNAVAILABLE",
          "Google Drive is unavailable right now. Nothing was changed; please try again shortly.");
    }
  },
};

// ---- rows ----

export type DriveDocumentResponse = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  webViewLink: string | null;
  folderId: string | null;
  resumeId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const toResponse = (row: DocumentModel): DriveDocumentResponse => ({
  id: row.id,
  name: row.name,
  mimeType: row.mimeType,
  // bigint column; JSON has no bigint, and files are far below 2^53 bytes
  sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
  webViewLink: row.webViewLink,
  folderId: row.folderId,
  resumeId: row.resumeId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type DriveStatus = {
  /** The server can reach Clerk (Drive is available at all) */
  configured: boolean;
  /** Drive can be used now: permission granted and switched on in CareerPilot */
  connected: boolean;
  /** The Google account granted drive.file (through Clerk) */
  permissionGranted: boolean;
  googleEmail: string | null;
  folderId: string | null;
  folderName: string | null;
};

export type DriveFolder = { id: string; name: string; selected: boolean };

const mime = (file: DriveFile) => file.mimeType ?? PDF;

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestIdOf = (file: DriveFile) => {
  const value = appProperty(file, REQUEST_KEY);
  return value && UUID_TEXT.test(value) ? value : null;
};

export function cleanName(value: string | null | undefined, max: number): string {
  let cleaned = (value ?? "").replace(/[\x00-\x1F\x7F\\/]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > max) cleaned = cleaned.slice(0, max).trim();
  return cleaned || DEFAULT_FOLDER_NAME;
}

/** A safe file name ending in ".pdf" (no path separators or control characters, at most 150 chars). */
export function pdfName(value: string | null | undefined): string {
  let cleaned = (value ?? "").replace(/\.pdf$/i, "").replace(/[\x00-\x1F\x7F\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > 146) cleaned = cleaned.slice(0, 146).trim();
  return `${!cleaned || /^\.+$/.test(cleaned) ? "Document" : cleaned}.pdf`;
}

export function uniqueName(name: string, takenLowerCase: Set<string>): string {
  if (!takenLowerCase.has(name.toLowerCase())) return name;
  const isPdf = name.endsWith(".pdf");
  const base = isPdf ? name.slice(0, -4) : name;
  const extension = isPdf ? ".pdf" : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${extension}`;
    if (!takenLowerCase.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${randomUUID().slice(0, 8)})${extension}`;
}

type SettingsChanges = { enabled?: boolean; googleEmail?: string | null; folderId?: string | null; folderName?: string | null };

/** Drive's metadata for our row. */
const fileFields = (file: DriveFile) => ({
  name: file.name,
  folderId: firstParent(file),
  mimeType: mime(file),
  sizeBytes: sizeBytes(file) == null ? null : BigInt(sizeBytes(file)!),
  webViewLink: file.webViewLink ?? null,
});

/**
 * Drive access, folders and documents. Uploads are idempotent per request id; every action checks the document
 * belongs to the user and is a CareerPilot file in Drive; deleting moves the file to Drive's trash only after
 * explicit confirmation. Removing our metadata never deletes a Drive file.
 */
export class DriveService {
  private readonly uploads = new Map<string, Promise<DriveDocumentResponse>>();

  constructor(
    private readonly db: Db,
    private readonly google: GoogleAccounts,
    private readonly drive: DriveClient,
  ) {}

  get configured() {
    return this.google.configured;
  }

  // ---- access ----

  private settings(tx: Tx, userId: string) {
    return tx.driveSettings.findUnique({ where: { userId } });
  }

  private saveSettings(tx: Tx, userId: string, changes: SettingsChanges) {
    return tx.driveSettings.upsert({ where: { userId }, create: { userId, ...changes }, update: changes });
  }

  /** Settings row for the user (created on first use). Clears our document list if the Google account changed. */
  private settingsFor(user: User, account: GoogleAccount | null) {
    return this.db.$transaction(async (tx) => {
      const current = await this.settings(tx, user.id);
      const email = account?.email || null;
      const changes: SettingsChanges = {};
      if (email && current?.googleEmail && current.googleEmail !== email) {
        // Files from the previous Google account stay in that Drive; only our list of them is cleared
        await tx.driveDocument.deleteMany({ where: { userId: user.id } });
        changes.folderId = null;
        changes.folderName = null;
      }
      if (email) changes.googleEmail = email;
      return this.saveSettings(tx, user.id, changes);
    });
  }

  async requireUsable(user: User) {
    if (!this.configured) throw driveErrors.notConfigured();
    const current = await this.settings(this.db, user.id);
    if (current && !current.enabled) throw driveErrors.notConnected();
  }

  private async token(user: User): Promise<string> {
    const token = await this.google.findAccessToken(user.clerkUserId);
    if (!token) throw driveErrors.notConnected();
    if (!token.scopes.has(DRIVE_FILE_SCOPE)) throw driveErrors.permissionMissing();
    return token.value;
  }

  /**
   * Runs a Drive call with a fresh token from Clerk. A 401 gets one retry with a newly fetched token (Clerk refreshes
   * expired tokens); a second 401 means access was withdrawn at Google.
   */
  private async withToken<T>(user: User, call: (token: string) => Promise<T>): Promise<T> {
    await this.requireUsable(user);
    try {
      return await call(await this.token(user));
    } catch (error) {
      if (!(error instanceof DriveApiError)) throw error;
      if (error.status !== 401) throw driveErrors.from(error);
    }
    try {
      return await call(await this.token(user));
    } catch (error) {
      if (!(error instanceof DriveApiError)) throw error;
      throw error.status === 401 ? driveErrors.reconnectRequired() : driveErrors.from(error);
    }
  }

  // ---- connection and folders ----

  async status(user: User): Promise<DriveStatus> {
    if (!this.configured) {
      return { configured: false, connected: false, permissionGranted: false, googleEmail: null, folderId: null, folderName: null };
    }
    const account = await this.google.findGoogleAccount(user.clerkUserId);
    const granted = !!account?.approvedScopes.has(DRIVE_FILE_SCOPE);
    const current = await this.settingsFor(user, account);
    const connected = granted && current.enabled;
    return {
      configured: true,
      connected,
      permissionGranted: granted,
      googleEmail: account?.email ?? null,
      folderId: connected ? current.folderId : null,
      folderName: connected ? current.folderName : null,
    };
  }

  /** Switches Drive on; says whether the browser still needs to ask Google (via Clerk) for drive.file. */
  async connect(user: User): Promise<{ needsGoogleConsent: boolean; scope: string }> {
    if (!this.configured) throw driveErrors.notConfigured();
    const account = await this.google.findGoogleAccount(user.clerkUserId);
    await this.settingsFor(user, account);
    await this.saveSettings(this.db, user.id, { enabled: true });
    return { needsGoogleConsent: !account?.approvedScopes.has(DRIVE_FILE_SCOPE), scope: DRIVE_FILE_SCOPE };
  }

  /** Switches Drive off and forgets our folder choice and document list. Files in Drive are not touched. */
  async disconnect(user: User) {
    await this.db.$transaction(async (tx) => {
      await this.saveSettings(tx, user.id, { enabled: false, folderId: null, folderName: null });
      await tx.driveDocument.deleteMany({ where: { userId: user.id } });
    });
  }

  async folders(user: User): Promise<DriveFolder[]> {
    const selected = (await this.settings(this.db, user.id))?.folderId ?? null;
    const folders = await this.withToken(user, (token) => this.drive.list(token,
      `mimeType = '${FOLDER_MIME_TYPE}' and trashed = false and appProperties has { key='${APP_KEY}' and value='${FOLDER_MARKER}' }`, 3));
    return folders.map((f) => ({ id: f.id, name: f.name, selected: f.id === selected }));
  }

  async createFolder(user: User, name: string): Promise<DriveFolder> {
    const cleaned = cleanName(name, 100);
    const folder = await this.withToken(user, (token) => this.drive.createFolder(token, cleaned, { [APP_KEY]: FOLDER_MARKER }));
    await this.saveSettings(this.db, user.id, { folderId: folder.id, folderName: folder.name });
    return { id: folder.id, name: folder.name, selected: true };
  }

  async selectFolder(user: User, folderId: string): Promise<DriveFolder> {
    const folder = await this.appFolder(user, folderId);
    await this.saveSettings(this.db, user.id, { folderId: folder.id, folderName: folder.name });
    return { id: folder.id, name: folder.name, selected: true };
  }

  /**
   * The folder new documents go into: the requested one (must be a CareerPilot folder), else the selected one, else
   * a new "CareerPilot" folder created on first use.
   */
  private async resolveUploadFolder(user: User, requestedFolderId: string | null | undefined): Promise<DriveFile> {
    if (requestedFolderId?.trim()) return this.appFolder(user, requestedFolderId);
    const selected = (await this.settings(this.db, user.id))?.folderId ?? null;
    if (selected) {
      try {
        return await this.appFolder(user, selected);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "DRIVE_FOLDER_NOT_FOUND") throw error;
        // The selected folder was deleted in Drive: fall back to a fresh default folder
      }
    }
    const folder = await this.withToken(user,
      (token) => this.drive.createFolder(token, DEFAULT_FOLDER_NAME, { [APP_KEY]: FOLDER_MARKER }));
    await this.saveSettings(this.db, user.id, { folderId: folder.id, folderName: folder.name });
    return folder;
  }

  private async appFolder(user: User, folderId: string): Promise<DriveFile> {
    let folder: DriveFile;
    try {
      folder = await this.withToken(user, (token) => this.drive.get(token, folderId));
    } catch (error) {
      if (error instanceof ApiError && error.code === "DRIVE_DOCUMENT_NOT_FOUND") throw driveErrors.folderNotFound();
      throw error;
    }
    if (!folder || folder.trashed === true || folder.mimeType !== FOLDER_MIME_TYPE
      || appProperty(folder, APP_KEY) !== FOLDER_MARKER) {
      throw driveErrors.folderNotFound();
    }
    return folder;
  }

  // ---- documents ----

  /**
   * Uploads a PDF into the chosen (or default) CareerPilot folder. A name already used in that folder gets a " (2)",
   * " (3)" … suffix. Retrying with the same requestId returns the first upload instead of creating a second file.
   */
  async uploadPdf(user: User, requestId: string, fileName: string, folderId: string | null | undefined,
    resumeId: string | null | undefined, content: Uint8Array): Promise<DriveDocumentResponse> {
    await this.requireUsable(user);
    const key = `${user.id}:${requestId}`;
    const running = this.uploads.get(key);
    if (running) return running;
    const upload = this.doUpload(user, requestId, fileName, folderId, resumeId ?? null, content)
      .finally(() => this.uploads.delete(key));
    this.uploads.set(key, upload);
    return upload;
  }

  private async doUpload(user: User, requestId: string, fileName: string, folderId: string | null | undefined,
    resumeId: string | null, content: Uint8Array): Promise<DriveDocumentResponse> {
    const existing = await this.db.driveDocument.findFirst({ where: { userId: user.id, requestId } });
    if (existing) return toResponse(existing);

    // A previous attempt may have reached Drive before the connection dropped: reuse that file
    const earlier = await this.withToken(user, (token) => this.drive.list(token,
      `trashed = false and appProperties has { key='${REQUEST_KEY}' and value='${requestId}' }`, 1));
    let file: DriveFile;
    if (earlier[0]) {
      file = earlier[0];
    } else {
      const folder = await this.resolveUploadFolder(user, folderId);
      const taken = await this.namesIn(user, folder.id);
      const name = uniqueName(pdfName(fileName), taken);
      file = await this.withToken(user, (token) => this.drive.upload(token, name, folder.id, PDF,
        { [APP_KEY]: DOCUMENT_MARKER, [REQUEST_KEY]: requestId }, content));
    }
    return toResponse(await this.record(user.id, file, requestId, resumeId));
  }

  /** CareerPilot files in the user's Drive, refreshed from Drive (files deleted there disappear here). */
  async list(user: User): Promise<DriveDocumentResponse[]> {
    await this.requireUsable(user);
    const files = await this.withToken(user, (token) => this.drive.list(token,
      `trashed = false and appProperties has { key='${APP_KEY}' and value='${DOCUMENT_MARKER}' }`, 5));
    const byId = new Map(files.map((file) => [file.id, file]));
    await this.db.$transaction(async (tx) => {
      for (const row of await tx.driveDocument.findMany({ where: { userId: user.id } })) {
        const file = byId.get(row.driveFileId);
        byId.delete(row.driveFileId);
        if (!file) {
          // Gone or trashed in Drive: forget our metadata only
          await tx.driveDocument.delete({ where: { id: row.id } });
        } else {
          await refresh(tx, row, file);
        }
      }
      if (byId.size > 0) {
        await tx.driveDocument.createMany({
          data: [...byId.values()].map((file) => ({ userId: user.id, driveFileId: file.id, requestId: requestIdOf(file), ...fileFields(file) })),
          skipDuplicates: true,
        });
      }
    });
    const rows = await this.db.driveDocument.findMany({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });
    return rows.map(toResponse);
  }

  async rename(user: User, documentId: string, newName: string): Promise<DriveDocumentResponse> {
    await this.requireUsable(user);
    const document = await this.owned(this.db, user.id, documentId);
    const name = document.mimeType === PDF ? pdfName(newName) : cleanName(newName, 150);
    const taken = await this.db.driveDocument.count({ where: {
      userId: user.id, id: { not: documentId }, folderId: document.folderId, name: { equals: name, mode: "insensitive" },
    } });
    if (taken > 0) {
      throw new ApiError(409, "DRIVE_NAME_TAKEN",
        `Another document in this folder is already called "${name}". Choose a different name.`);
    }
    const updated = await this.withToken(user, (token) => this.drive.update(token, document.driveFileId, { name }));
    return this.db.$transaction(async (tx) => toResponse(await refresh(tx, await this.owned(tx, user.id, documentId), updated)));
  }

  /** Moves the file to Drive's trash. Requires confirmation; nothing happens otherwise. */
  async trash(user: User, documentId: string, confirmed: boolean) {
    if (!confirmed) {
      throw new ApiError(400, "CONFIRMATION_REQUIRED",
        "Confirm that you want to move this document to your Google Drive trash.");
    }
    await this.requireUsable(user);
    const document = await this.owned(this.db, user.id, documentId);
    try {
      await this.withToken(user, (token) => this.drive.update(token, document.driveFileId, { trashed: true }));
    } catch (error) {
      // Keep our record so the user can retry, unless it's already gone from Drive
      if (!(error instanceof ApiError) || error.code !== "DRIVE_DOCUMENT_NOT_FOUND") throw error;
    }
    await this.db.driveDocument.deleteMany({ where: { id: documentId, userId: user.id } });
  }

  async download(user: User, documentId: string): Promise<{ name: string; mimeType: string; content: Buffer }> {
    await this.requireUsable(user);
    const document = await this.owned(this.db, user.id, documentId);
    const file = await this.withToken(user, (token) => this.drive.get(token, document.driveFileId));
    if (!file || file.trashed === true || appProperty(file, APP_KEY) !== DOCUMENT_MARKER) throw driveErrors.documentNotFound();
    const content = await this.withToken(user,
      (token) => this.drive.download(token, document.driveFileId, MAX_DOWNLOAD_BYTES));
    return { name: file.name, mimeType: mime(file), content };
  }

  private async record(userId: string, file: DriveFile, requestId: string, resumeId: string | null): Promise<DocumentModel> {
    try {
      return await this.db.$transaction(async (tx) => {
        const row = await tx.driveDocument.findFirst({ where: { userId, driveFileId: file.id } });
        if (row) return refresh(tx, row, file);
        return tx.driveDocument.create({ data: { userId, driveFileId: file.id, requestId, resumeId, ...fileFields(file) } });
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      // A parallel request recorded the same upload first
      const row = await this.db.driveDocument.findFirst({
        where: { userId, OR: [{ requestId }, { driveFileId: file.id }] },
      });
      if (!row) throw error;
      return row;
    }
  }

  private async namesIn(user: User, folderId: string): Promise<Set<string>> {
    const files = await this.withToken(user, (token) => this.drive.list(token, `'${folderId}' in parents and trashed = false`, 5));
    return new Set(files.map((file) => file.name.toLowerCase()));
  }

  private async owned(tx: Tx, userId: string, documentId: string): Promise<DocumentModel> {
    const row = await tx.driveDocument.findFirst({ where: { id: documentId, userId } });
    if (!row) throw driveErrors.documentNotFound();
    return row;
  }
}

/** Copies Drive's metadata onto our row; updatedAt changes only when something did. */
async function refresh(tx: Tx, row: DocumentModel, file: DriveFile): Promise<DocumentModel> {
  const next = fileFields(file);
  const changed = next.name !== row.name || next.folderId !== row.folderId || next.mimeType !== row.mimeType
    || next.sizeBytes !== row.sizeBytes || next.webViewLink !== row.webViewLink;
  return changed ? tx.driveDocument.update({ where: { id: row.id }, data: next }) : row;
}

const folderId = z.string({ required_error: "is required" }).regex(/^[A-Za-z0-9_-]{1,128}$/, "is not a folder id");
const createFolderSchema = z.object({ name: requiredText(100) });
const selectFolderSchema = z.object({ folderId });
const renameSchema = z.object({ name: requiredText(150) });

export function driveRouter(drive: DriveService): Router {
  const router = Router();
  const documentNotFound = driveErrors.documentNotFound();

  router.get("/status", async (_req, res) => {
    res.json(await drive.status(currentUser(res)));
  });

  /** Switches Drive on; says whether the browser still needs to ask Google (via Clerk) for drive.file. */
  router.post("/connect", async (_req, res) => {
    res.json(await drive.connect(currentUser(res)));
  });

  /** Switches Drive off in CareerPilot. Files already in Drive stay there. */
  router.delete("/connection", async (_req, res) => {
    await drive.disconnect(currentUser(res));
    res.status(204).end();
  });

  router.get("/folders", async (_req, res) => {
    res.json(await drive.folders(currentUser(res)));
  });

  router.post("/folders", async (req, res) => {
    res.status(201).json(await drive.createFolder(currentUser(res), body(req, createFolderSchema).name));
  });

  router.put("/folder", async (req, res) => {
    res.json(await drive.selectFolder(currentUser(res), body(req, selectFolderSchema).folderId));
  });

  router.get("/documents", async (_req, res) => {
    res.json(await drive.list(currentUser(res)));
  });

  router.patch("/documents/:id", async (req, res) => {
    const id = uuidParam(req, "id", documentNotFound);
    res.json(await drive.rename(currentUser(res), id, body(req, renameSchema).name));
  });

  /** Moves the file to the Drive trash. Requires ?confirm=true. */
  router.delete("/documents/:id", async (req, res) => {
    await drive.trash(currentUser(res), uuidParam(req, "id", documentNotFound), flag(req, "confirm"));
    res.status(204).end();
  });

  router.get("/documents/:id/download", async (req, res) => {
    const file = await drive.download(currentUser(res), uuidParam(req, "id", documentNotFound));
    res.status(200)
      .type(file.mimeType === PDF ? PDF : "application/octet-stream")
      .set("Content-Disposition", attachment(file.name))
      .set("Cache-Control", "no-store")
      .set("X-Content-Type-Options", "nosniff")
      .send(file.content);
  });

  return router;
}
