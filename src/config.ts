import "dotenv/config";
import { z } from "zod";

/*
 * All settings come from environment variables (.env locally, the host's settings in production).
 * Validated once at startup so a missing value fails fast with a clear message, not on the first request.
 */

const list = (value: string | undefined, fallback: string[] = []) =>
  value === undefined || value.trim() === ""
    ? fallback
    : value.split(",").map((item) => item.trim()).filter(Boolean);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (PostgreSQL connection string)"),
  CLERK_ISSUER: z
    .string()
    .startsWith("https://", "CLERK_ISSUER must be your Clerk Frontend API URL, e.g. https://xxxx.clerk.accounts.dev"),
  CLERK_AUTHORIZED_PARTIES: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(512 * 1024),
  RESUME_VERSIONS_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  PDF_MAX_PAGES: z.coerce.number().int().positive().default(10),
  PDF_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  PDF_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
  PDF_MAX_QUEUED: z.coerce.number().int().nonnegative().default(8),
  DISCOVERY_BOARDS: z.string().optional(),
  /** Shared with the MCP server only; when set, the API accepts its short-lived service tokens. At least 32 characters. */
  MCP_SERVICE_SECRET: z.string().trim().min(32, "MCP_SERVICE_SECRET must be at least 32 characters").optional()
    .or(z.literal("").transform(() => undefined)),
});

export type Config = {
  port: number;
  databaseUrl: string;
  clerk: {
    /** Without a trailing slash, as in the token's "iss" */
    issuer: string;
    jwksUrl: string;
    authorizedParties: string[];
    webhookSecret: string | null;
    secretKey: string | null;
  };
  corsOrigins: string[];
  maxRequestBytes: number;
  resumeVersionsEnabled: boolean;
  pdf: {
    maxPages: number;
    maxBytes: number;
    renderTimeoutMs: number;
    maxConcurrent: number;
    maxQueued: number;
  };
  discoveryBoards: string[];
  /** Secret for the MCP server's service tokens; null turns them off */
  mcpServiceSecret: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${problems}`);
  }
  const e = parsed.data;
  const issuer = e.CLERK_ISSUER.replace(/\/+$/, "");
  const blank = (value: string | undefined) => (value && value.trim() ? value.trim() : null);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    clerk: {
      issuer,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      authorizedParties: list(e.CLERK_AUTHORIZED_PARTIES, ["http://localhost:3000"]),
      webhookSecret: blank(e.CLERK_WEBHOOK_SECRET),
      secretKey: blank(e.CLERK_SECRET_KEY),
    },
    corsOrigins: list(e.CORS_ALLOWED_ORIGINS, ["http://localhost:3000"]),
    maxRequestBytes: e.MAX_REQUEST_BYTES,
    resumeVersionsEnabled: e.RESUME_VERSIONS_ENABLED,
    pdf: {
      maxPages: e.PDF_MAX_PAGES,
      maxBytes: e.PDF_MAX_BYTES,
      renderTimeoutMs: e.PDF_RENDER_TIMEOUT_MS,
      maxConcurrent: e.PDF_MAX_CONCURRENT,
      maxQueued: e.PDF_MAX_QUEUED,
    },
    discoveryBoards: list(e.DISCOVERY_BOARDS),
    mcpServiceSecret: e.MCP_SERVICE_SECRET ?? null,
  };
}

/** Never log secrets: a printable summary of the configuration. */
export function describeConfig(config: Config) {
  return {
    port: config.port,
    clerkIssuer: config.clerk.issuer,
    authorizedParties: config.clerk.authorizedParties,
    webhookSecret: config.clerk.webhookSecret ? "<set>" : "<unset>",
    secretKey: config.clerk.secretKey ? "<set>" : "<unset>",
    corsOrigins: config.corsOrigins,
    resumeVersionsEnabled: config.resumeVersionsEnabled,
  };
}
