import { describe, expect, it } from "vitest";

import { checkCss, contrastWarning } from "../../src/docengine/css-rules.js";
import { writeDocJson } from "../../src/docengine/doc-json.js";
import { attachment, pdfFileName } from "../../src/docengine/engine.js";
import { parseInlineHtml } from "../../src/docengine/inline-html.js";
import { DocPresets } from "../../src/docengine/presets.js";
import { DEFAULT_MARGIN, normaliseMargin, readDoc } from "../../src/docengine/reader.js";
import { documentLink, webLink } from "../../src/docengine/safe-urls.js";
import { toXhtml } from "../../src/docengine/writer.js";

const minimal = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 3,
  document: "resume",
  sections: [{ id: "main", nodes }],
  ...extra,
});

const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe("CSS rules", () => {
  it("accepts allowlisted declarations and normalizes keywords", () => {
    expect(checkCss("color", "#FFF")).toMatchObject({ code: null, value: "#fff" });
    expect(checkCss("font-size", "8pt").code).toBeNull();
    expect(checkCss("margin", "4mm auto").code).toBeNull();
    expect(checkCss("border-bottom", "1pt solid #c1c7d0").code).toBeNull();
    expect(checkCss("line-height", "1.35").code).toBeNull();
  });

  it("maps font families to the bundled fonts", () => {
    expect(checkCss("font-family", "serif, Inter").value).toBe('"Source Serif 4", "Inter"');
    expect(checkCss("font-family", "Comic Sans").code).toBe("CSS_FONT_UNAVAILABLE");
  });

  it("refuses blocked properties, resource loads and unsupported layout", () => {
    expect(checkCss("position", "absolute").code).toBe("CSS_PROPERTY_BLOCKED");
    expect(checkCss("letter-spacing", "2pt").code).toBe("CSS_PROPERTY_BLOCKED");
    expect(checkCss("background-color", "url(https://evil.example/x)").code).toBe("CSS_VALUE_BLOCKED");
    expect(checkCss("color", "red !important").code).toBe("CSS_VALUE_BLOCKED");
    expect(checkCss("display", "flex").code).toBe("CSS_LAYOUT_UNSUPPORTED");
    expect(checkCss("transition", "all 1s").code).toBe("CSS_PROPERTY_UNKNOWN");
  });

  it("checks ranges", () => {
    expect(checkCss("font-size", "50pt").code).toBe("CSS_VALUE_INVALID");
    expect(checkCss("margin-top", "4mm 2mm").code).toBe("CSS_VALUE_INVALID");
    expect(checkCss("padding", "-2mm").code).toBe("CSS_VALUE_INVALID");
    expect(checkCss("orphans", "11").code).toBe("CSS_VALUE_INVALID");
  });

  it("warns about low contrast", () => {
    expect(contrastWarning({ color: "#eeeeee" })).toMatch(/Text contrast is/);
    expect(contrastWarning({ color: "#1f2328" })).toBeNull();
  });
});

describe("links", () => {
  it("normalizes web links and refuses dangerous ones", () => {
    expect(webLink("github.com/raj")).toBe("https://github.com/raj");
    expect(webLink("https://example.com")).toBe("https://example.com");
    expect(webLink("javascript:alert(1)")).toBeNull();
    expect(webLink("https://user:pw@example.com")).toBeNull();
    expect(webLink("data:text/html,hi")).toBeNull();
    expect(webLink("nohost")).toBeNull();
  });

  it("allows mailto and tel in documents", () => {
    expect(documentLink("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(documentLink("tel:+91 98765 43210")).toBe("tel:+919876543210");
    expect(documentLink("file:///etc/passwd")).toBeNull();
  });
});

describe("inline html", () => {
  it("keeps inline formatting, drops scripts and unsafe links", () => {
    const result = parseInlineHtml('Cut <b>40%</b> <script>alert(1)</script><a href="javascript:x">y</a>');
    expect(result.html).toBe("Cut <b>40%</b> <span>y</span>");
    expect(codes(result.problems)).toEqual(expect.arrayContaining(["INLINE_TAG_NOT_ALLOWED", "UNSAFE_LINK"]));
  });

  it("unwraps unknown tags but keeps their text", () => {
    const result = parseInlineHtml("<div>Hello <i>there</i></div>");
    expect(result.html).toBe("Hello <i>there</i>");
  });

  it("escapes text when writing back", () => {
    expect(parseInlineHtml("a &lt; b &amp; c").html).toBe("a &lt; b &amp; c");
  });
});

describe("reader", () => {
  it("reads a minimal valid document with defaults", () => {
    const result = readDoc(minimal([{ tag: "p", text: "Hi" }]), "STRICT");
    expect(result.errors).toEqual([]);
    expect(result.doc?.page).toEqual({ size: "A4", margin: DEFAULT_MARGIN, maxPages: 10, pageNumbers: true });
    expect(result.doc?.meta.language).toBe("en");
  });

  it("rejects broken rules in strict mode", () => {
    const result = readDoc(minimal([{ tag: "p", text: "Hi", bogus: 1 }, { tag: "script", text: "x" }]), "STRICT");
    expect(result.doc).toBeNull();
    expect(codes(result.errors)).toEqual(expect.arrayContaining(["UNKNOWN_FIELD", "TAG_BLOCKED"]));
    expect(result.errors[0]!.path).toBe("/sections/0/nodes/0/bogus");
  });

  it("repairs the same document in lenient mode", () => {
    const result = readDoc(minimal([{ tag: "p", text: "Hi", bogus: 1 }, { tag: "script", text: "x" }]), "LENIENT");
    expect(result.errors).toEqual([]);
    expect(result.doc?.sections[0]!.nodes).toHaveLength(1);
    expect(codes(result.warnings)).toEqual(expect.arrayContaining(["UNKNOWN_FIELD", "TAG_BLOCKED"]));
  });

  it("checks structure: list items need a list", () => {
    const strict = readDoc(minimal([{ tag: "li", text: "x" }]), "STRICT");
    expect(codes(strict.errors)).toContain("TAG_WRONG_PARENT");
    const lenient = readDoc(minimal([{ tag: "li", text: "x" }]), "LENIENT");
    expect(lenient.doc?.sections[0]!.nodes[0]!.tag).toBe("div");
  });

  it("turns blocks inside inline content into spans", () => {
    const result = readDoc(minimal([{ tag: "p", children: [{ tag: "div", text: "x" }] }]), "LENIENT");
    expect(result.doc?.sections[0]!.nodes[0]!.children[0]!.tag).toBe("span");
    expect(codes(result.warnings)).toContain("BLOCK_IN_INLINE");
  });

  it("gives duplicate section ids a unique replacement in lenient mode", () => {
    const doc = { schemaVersion: 3, document: "resume", sections: [{ id: "a", nodes: [] }, { id: "a", nodes: [] }] };
    const result = readDoc(doc, "LENIENT");
    expect(result.doc?.sections.map((s) => s.id)).toEqual(["a", "s2"]);
    expect(codes(result.warnings)).toContain("ID_DUPLICATE");
  });

  it("warns about classes that no style defines, without failing", () => {
    const result = readDoc(minimal([{ tag: "p", class: "muted", text: "x" }]), "STRICT");
    expect(result.doc).not.toBeNull();
    expect(codes(result.warnings)).toContain("CLASS_UNDEFINED");
  });

  it("validates links, data dates and attributes", () => {
    const result = readDoc(minimal([
      { tag: "a", attrs: { href: "javascript:alert(1)" }, text: "x" },
      { tag: "div", data: { start: "Jan 2022" } },
      { tag: "p", attrs: { onclick: "x" }, text: "y" },
    ]), "STRICT");
    expect(codes(result.errors)).toEqual(expect.arrayContaining(["UNSAFE_LINK", "DATA_DATE_FORMAT", "ATTR_BLOCKED"]));
  });

  it("normalizes page margins", () => {
    expect(normaliseMargin("12mm 16mm")).toBe("12mm 16mm 12mm 16mm");
    expect(normaliseMargin("1in")).toBe("25.4mm 25.4mm 25.4mm 25.4mm");
    expect(normaliseMargin("50mm")).toBeNull();
  });

  it("round-trips through JSON", () => {
    const original = readDoc(minimal([{ tag: "p", class: "x", style: { color: "#111111" }, html: "<b>Hi</b>" }],
      { styles: { ".x": { "font-weight": "bold" } }, meta: { title: "T" } }), "STRICT").doc!;
    const again = readDoc(writeDocJson(original), "STRICT").doc!;
    expect(again).toEqual(original);
  });
});

describe("writer", () => {
  it("escapes text and writes line breaks", () => {
    const doc = readDoc(minimal([{ tag: "p", text: "<script>alert(1)</script>\nnext" }]), "STRICT").doc!;
    const xhtml = toXhtml(doc, {});
    expect(xhtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;<br />next");
    expect(xhtml).not.toContain("<script>");
    expect(xhtml).toContain("@page {\n  size: A4;");
  });

  it("gives links an accessible title and skips hidden nodes", () => {
    const doc = readDoc(minimal([
      { tag: "a", attrs: { href: "https://example.com" }, text: "Site" },
      { tag: "p", visible: false, text: "secret" },
    ]), "STRICT").doc!;
    const xhtml = toXhtml(doc, {});
    expect(xhtml).toContain('<a href="https://example.com" title="Site">Site</a>');
    expect(xhtml).not.toContain("secret");
  });
});

describe("presets", () => {
  it("loads and validates the bundled presets", () => {
    const presets = new DocPresets();
    expect(presets.all().map((p) => p.id)).toEqual(["classic", "modern"]);
    expect(Object.keys(presets.find("classic")!.styles).length).toBeGreaterThan(0);
    expect(presets.find("nope")).toBeNull();
  });
});

describe("download names", () => {
  it("cleans file names", () => {
    const doc = readDoc(minimal([]), "LENIENT").doc!;
    expect(pdfFileName("my/cv:final.pdf", doc)).toBe("my cv final.pdf");
    expect(pdfFileName(null, doc)).toBe("Resume.pdf");
    expect(pdfFileName("...", doc)).toBe("Document.pdf");
  });

  it("encodes non-ASCII names for Content-Disposition", () => {
    expect(attachment("Résumé.pdf")).toBe("attachment; filename=\"R_sum_.pdf\"; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf");
  });
});
