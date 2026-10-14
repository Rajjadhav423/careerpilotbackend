import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConfig } from "../../src/config.js";
import { convert, length, Limiter, listMarker, withTimeout } from "../../src/docengine/pdf.js";
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

});

describe("CSS to PDF styles", () => {
  it("converts lengths to points", () => {
    expect(length("10pt", 10)).toBe(10);
    expect(length("25.4mm", 10)).toBe(72);
    expect(length("1in", 10)).toBe(72);
    expect(length("8px", 10)).toBe(6);
    expect(length("1.5em", 10)).toBe(15);
    expect(length("50%", 10)).toBe("50%");
    expect(length("0", 10)).toBe(0);
    expect(length("auto", 10)).toBe("auto");
  });

  it("converts text and box properties", () => {
    const c = convert({
      "font-family": '"Source Serif 4", "Inter"', "font-size": "1.2em", "font-weight": "bold", color: "navy",
      "line-height": "13pt", margin: "4pt 2mm", "border-bottom": "0.75pt solid #1f2328", "text-align": "end",
    }, 10);
    expect(c.fontSize).toBe(12);
    expect(c.style).toMatchObject({
      fontFamily: "Source Serif 4", fontSize: 12, fontWeight: 700, color: "#000080", lineHeight: 1.08,
      marginTop: 4, marginBottom: 4, marginRight: 5.67, marginLeft: 5.67,
      borderBottomWidth: 0.75, borderBottomStyle: "solid", borderBottomColor: "#1f2328", textAlign: "right",
    });
  });

  it("restates the inherited line height where the font size changes", () => {
    expect(convert({ "font-size": "21pt" }, 10, 1.38).style.lineHeight).toBe(1.38);
    expect(convert({ color: "red" }, 10, 1.38).style.lineHeight).toBeUndefined();
    expect(convert({ "line-height": "1.1" }, 10, 1.38).lineHeight).toBe(1.1);
  });

  it("turns page-break hints into react-pdf props", () => {
    expect(convert({ "page-break-inside": "avoid" }, 10).props).toEqual({ wrap: false });
    expect(convert({ "page-break-before": "always" }, 10).props).toEqual({ break: true });
    expect(convert({ "page-break-after": "avoid", "-fs-page-break-min-height": "2.6cm" }, 10).props.minPresenceAhead).toBe(73.7);
    expect(convert({ "page-break-after": "always" }, 10).breakAfter).toBe(true);
  });

  it("reads layout hints", () => {
    expect(convert({ display: "table-cell", "white-space": "nowrap", float: "right" }, 10))
      .toMatchObject({ display: "table-cell", nowrap: true, float: "right" });
  });

  it("numbers list items", () => {
    expect(listMarker("disc", 1)).toBe("•");
    expect(listMarker("decimal", 3)).toBe("3.");
    expect(listMarker("lower-alpha", 28)).toBe("ab.");
    expect(listMarker("upper-roman", 14)).toBe("XIV.");
    expect(listMarker("none", 1)).toBeNull();
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
