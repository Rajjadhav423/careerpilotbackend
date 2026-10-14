import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConfig } from "../../src/config.js";
import { Limiter, withFonts, withTimeout } from "../../src/docengine/pdf.js";
import { cleanName, pdfName, uniqueName } from "../../src/drive/drive.js";
import { ApiError, fieldErrors } from "../../src/http/errors.js";

describe("configuration", () => {
  const base = { DATABASE_URL: "postgres://localhost/careerpilot", CLERK_ISSUER: "https://x.clerk.accounts.dev/" };

  it("reads settings with defaults", () => {
    const config = loadConfig({ ...base, CORS_ALLOWED_ORIGINS: "https://a.com, https://b.com", RESUME_VERSIONS_ENABLED: "true" });
    expect(config.port).toBe(8080);
    expect(config.clerk.issuer).toBe("https://x.clerk.accounts.dev");
    expect(config.clerk.jwksUrl).toBe("https://x.clerk.accounts.dev/.well-known/jwks.json");
    expect(config.clerk.authorizedParties).toEqual(["http://localhost:3000"]);
    expect(config.clerk.webhookSecret).toBeNull();
    expect(config.corsOrigins).toEqual(["https://a.com", "https://b.com"]);
    expect(config.resumeVersionsEnabled).toBe(true);
    expect(config.maxRequestBytes).toBe(512 * 1024);
    expect(config.pdf.maxPages).toBe(10);
  });

  it("fails fast on missing or wrong values", () => {
    expect(() => loadConfig({ CLERK_ISSUER: base.CLERK_ISSUER })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, CLERK_ISSUER: "http://insecure" })).toThrow(/CLERK_ISSUER/);
    expect(loadConfig({ ...base, RESUME_VERSIONS_ENABLED: "yes" }).resumeVersionsEnabled).toBe(false);
  });
});

describe("field errors", () => {
  it("writes paths like the Spring backend", () => {
    const schema = z.object({ a: z.object({ b: z.array(z.object({ c: z.string() })) }) });
    const result = schema.safeParse({ a: { b: [{ c: "x" }, { c: 1 }] } });
    expect(fieldErrors(result.error!.issues)).toEqual({ "a.b[1].c": "Expected string, received number" });
    expect(fieldErrors(result.error!.issues, "data")).toHaveProperty(["data.a.b[1].c"]);
  });
});

describe("PDF limits", () => {
  it("runs a few tasks at a time and refuses when the queue is full", async () => {
    const limiter = new Limiter(1, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = limiter.run(() => gate.then(() => "first"));
    const second = limiter.run(async () => "second");
    await expect(limiter.run(async () => "third")).rejects.toMatchObject({ code: "DOCUMENT_BUSY", status: 503 });
    release();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
  });

  it("times out slow work", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 10, () => new ApiError(503, "DOCUMENT_TIMEOUT", "slow")))
      .rejects.toMatchObject({ code: "DOCUMENT_TIMEOUT" });
    expect(await withTimeout(Promise.resolve(5), 100, () => new Error("x"))).toBe(5);
  });

  it("adds the bundled fonts, served from memory", () => {
    const html = withFonts("<html><head><style>\nbody{}</style></head></html>");
    expect(html).toContain('@font-face { font-family: "Inter"; src: url("https://fonts.careerpilot.invalid/Inter-Regular.ttf")');
    expect(html).toContain("font-variant-ligatures: none");
  });
});

describe("Drive names", () => {
  it("cleans names and avoids clashes", () => {
    expect(pdfName("../etc/passwd")).toBe(".. etc passwd.pdf");
    expect(pdfName("Resume.PDF")).toBe("Resume.pdf");
    expect(pdfName("")).toBe("Document.pdf");
    expect(cleanName("  a/b\\c  ", 100)).toBe("a b c");
    expect(cleanName("   ", 100)).toBe("CareerPilot");
    expect(uniqueName("CV.pdf", new Set(["cv.pdf", "cv (2).pdf"]))).toBe("CV (3).pdf");
    expect(uniqueName("CV.pdf", new Set())).toBe("CV.pdf");
  });
});
