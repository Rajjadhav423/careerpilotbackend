import { randomUUID } from "node:crypto";

/*
 * The few Drive v3 calls CareerPilot needs. With the drive.file permission Google itself only lets these calls see
 * files and folders this app created, so there is no way to browse or change the rest of a Drive. Failures surface as
 * DriveApiError; callers turn them into user-facing errors.
 */

export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,size,webViewLink,parents,appProperties,trashed,createdTime,modifiedTime";
/** Drive file ids are URL-safe base64-like strings; anything else never reaches Google. */
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type DriveFile = {
  id: string;
  name: string;
  mimeType?: string | null;
  size?: string | null;
  webViewLink?: string | null;
  parents?: string[] | null;
  appProperties?: Record<string, string> | null;
  trashed?: boolean | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
};

export const sizeBytes = (file: DriveFile) => {
  if (file.size == null) return null;
  const n = Number(file.size);
  return Number.isSafeInteger(n) ? n : null;
};
export const firstParent = (file: DriveFile) => file.parents?.[0] ?? null;
export const appProperty = (file: DriveFile, key: string) => file.appProperties?.[key] ?? null;

/** A Drive request failed. `reason` is Google's machine-readable reason when known. */
export class DriveApiError extends Error {
  constructor(readonly status: number, readonly reason: string | null) {
    super(`Drive request failed with status ${status}`);
    this.name = "DriveApiError";
  }
}

export interface DriveClient {
  list(token: string, query: string, maxPages: number): Promise<DriveFile[]>;
  get(token: string, fileId: string): Promise<DriveFile>;
  createFolder(token: string, name: string, appProperties: Record<string, string>): Promise<DriveFile>;
  upload(token: string, name: string, parentId: string | null, mimeType: string, appProperties: Record<string, string>,
    content: Uint8Array): Promise<DriveFile>;
  update(token: string, fileId: string, changes: Record<string, unknown>): Promise<DriveFile>;
  download(token: string, fileId: string, maxBytes: number): Promise<Buffer>;
  /** Lets anyone with the link view the file (no sign-in needed). */
  shareWithLink(token: string, fileId: string): Promise<void>;
}

function requireFileId(fileId: string | null | undefined) {
  if (!fileId || !FILE_ID.test(fileId)) throw new DriveApiError(404, "invalidFileId");
}

export class GoogleDriveClient implements DriveClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://www.googleapis.com",
  ) {}

  /** Lists app-visible files matching a Drive query (all pages, up to maxPages × 100 files). */
  async list(token: string, query: string, maxPages: number): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "100",
        spaces: "drive",
        orderBy: "modifiedTime desc",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const result = (await this.json(token, `/drive/v3/files?${params}`)) as { files?: DriveFile[]; nextPageToken?: string } | null;
      if (!result?.files) break;
      files.push(...result.files);
      pageToken = result.nextPageToken ?? null;
      if (!pageToken?.trim()) break;
    }
    return files;
  }

  async get(token: string, fileId: string): Promise<DriveFile> {
    requireFileId(fileId);
    return (await this.json(token, `/drive/v3/files/${fileId}?fields=${encodeURIComponent(FILE_FIELDS)}`)) as DriveFile;
  }

  async createFolder(token: string, name: string, appProperties: Record<string, string>): Promise<DriveFile> {
    return (await this.json(token, `/drive/v3/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE, appProperties }),
    })) as DriveFile;
  }

  /** Multipart upload (metadata + content in one request, fine for files up to a few MB). */
  async upload(token: string, name: string, parentId: string | null, mimeType: string,
    appProperties: Record<string, string>, content: Uint8Array): Promise<DriveFile> {
    if (parentId != null) requireFileId(parentId);
    const metadata = parentId == null
      ? { name, mimeType, appProperties }
      : { name, mimeType, appProperties, parents: [parentId] };
    const boundary = `careerpilot-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`
        + `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, "utf8"),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    return (await this.json(token, `/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    })) as DriveFile;
  }

  /** Partial metadata update, e.g. {"name": …} to rename or {"trashed": true} to move to Drive's trash. */
  async update(token: string, fileId: string, changes: Record<string, unknown>): Promise<DriveFile> {
    requireFileId(fileId);
    return (await this.json(token, `/drive/v3/files/${fileId}?fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    })) as DriveFile;
  }

  async shareWithLink(token: string, fileId: string): Promise<void> {
    requireFileId(fileId);
    await this.send(token, `/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone", allowFileDiscovery: false }),
    });
  }

  /** File content, refusing anything larger than maxBytes. */
  async download(token: string, fileId: string, maxBytes: number): Promise<Buffer> {
    requireFileId(fileId);
    const response = await this.send(token, `/drive/v3/files/${fileId}?alt=media`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) throw new DriveApiError(413, "fileTooLarge");
    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > maxBytes) throw new DriveApiError(413, "fileTooLarge");
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  }

  private async json(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.send(token, path, init);
    return response.json();
  }

  private async send(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      console.warn(`Google Drive unreachable: ${(error as Error).name}`);
      throw new DriveApiError(503, "unreachable");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const reason = body.includes("storageQuotaExceeded") ? "storageQuotaExceeded"
        : body.includes("insufficientPermissions") || body.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
          ? "insufficientPermissions" : null;
      // Status and reason only: never tokens, file names or document content
      console.warn(`Google Drive request failed with status ${response.status}${reason ? ` (${reason})` : ""}`);
      throw new DriveApiError(response.status, reason);
    }
    return response;
  }
}
