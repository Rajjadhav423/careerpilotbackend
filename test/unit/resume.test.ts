import { describe, expect, it } from "vitest";

import { DocPresets } from "../../src/docengine/presets.js";
import { readDoc } from "../../src/docengine/reader.js";
import { fieldErrors } from "../../src/http/errors.js";
import { docDiff, resumeDiff } from "../../src/resumes/diff.js";
import { normalize, readResumeJson, resumeDataSchema } from "../../src/resumes/resume-data.js";
import { contactLink, dates, isoDate, resumeToDoc } from "../../src/resumes/resume-to-doc.js";
import { resumeFileName } from "../../src/resumes/resumes.js";
import { richTextParagraphs, richTextToPlain, richTextToXhtml } from "../../src/resumes/rich-text.js";
import { validResume } from "../helpers.js";

describe("resume data", () => {
  it("cleans text, drops empty items and fills ids", () => {
    const data = normalize({
      basics: { fullName: "  Priya \n Sharma ", links: [{ label: "x", url: " " }] },
      sections: [
        { type: "list", title: " Awards ", items: [{ text: "Best\u0007 speaker" }, { text: "   " }] },
        { id: "bad id!", type: "entries", title: "", entries: [{ title: "Eng", current: true, endDate: "2024" }] },
        { type: "nope", title: "Ignored" },
      ],
    });
    expect(data.basics.fullName).toBe("Priya Sharma");
    expect(data.basics.links).toEqual([]);
    expect(data.sections.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(data.sections[0]!.items).toEqual([{ id: "s1-i1", text: "Best speaker", visible: true }]);
    expect(data.sections[1]!.title).toBe("Section");
    expect(data.sections[1]!.entries[0]).toMatchObject({ id: "s2-e1", current: true, endDate: null });
    expect(data.layout).toBeNull();
  });

  it("makes duplicate ids unique", () => {
    const data = normalize({ basics: { fullName: "A" }, sections: [
      { id: "x", type: "text", title: "One", content: "a" },
      { id: "x", type: "text", title: "Two", content: "b" },
    ] });
    expect(data.sections.map((s) => s.id)).toEqual(["x", "x-2"]);
  });

  it("keeps paragraphs in multi-line text", () => {
    const data = normalize({ basics: { fullName: "A" }, sections: [
      { type: "text", title: "Summary", content: "Line one  \r\n\r\n\r\n\r\n  Line two" },
    ] });
    expect(data.sections[0]!.content).toBe("Line one\n\nLine two");
  });

  it("converts the original fixed-section format", () => {
    const data = normalize(readResumeJson({
      basics: { fullName: "Asha" },
      summary: "Hello",
      experience: [{ title: "Engineer", organization: "Acme", highlights: ["Shipped x"] }],
      languages: [{ name: "Hindi", proficiency: "Native" }],
    }));
    expect(data.sections.map((s) => s.id)).toEqual(["summary", "experience", "languages"]);
    expect(data.sections[1]!.entries[0]).toMatchObject({ id: "experience-e1", title: "Engineer", subtitle: "Acme",
      bullets: ["Shipped x"] });
    expect(data.sections[2]!.items[0]!.text).toBe("Hindi (Native)");
  });

  it("accepts a whole saved resume ({ data })", () => {
    expect(readResumeJson({ title: "x", data: { basics: { fullName: "A" } } })).toEqual({ basics: { fullName: "A" } });
    expect(() => readResumeJson([1, 2])).toThrow(/must be an object/);
  });

  it("validates input with the same field paths and messages", () => {
    const result = resumeDataSchema.safeParse({
      basics: { email: "not-an-email", links: [{ url: "javascript:alert(1)" }] },
      sections: [{ type: "entries", title: "x", entries: [{ title: "", bullets: [" "] }] }],
      layout: { marginTop: 2 },
    });
    expect(result.success).toBe(false);
    const errors = fieldErrors(result.error!.issues, "data");
    expect(errors).toMatchObject({
      "data.basics.fullName": "is required",
      "data.basics.email": "must be an email address",
      "data.basics.links[0].url": "must be a web address starting with http:// or https://",
      "data.sections[0].entries[0].title": "is required",
      "data.sections[0].entries[0].bullets[0]": "must not be blank",
      "data.layout.marginTop": "must be greater than or equal to 5",
    });
  });

  it("accepts a valid resume", () => {
    expect(resumeDataSchema.safeParse(validResume()).success).toBe(true);
  });
});

describe("rich text", () => {
  it("formats bold, italic and safe links, escaping everything else", () => {
    expect(richTextToXhtml("**bold** and *it* and snake_case_word and [x](javascript:alert(1)) <b>"))
      .toBe("<strong>bold</strong> and <em>it</em> and snake_case_word and x &lt;b&gt;");
    expect(richTextToXhtml("[site](https://example.com/a_(b))"))
      .toBe('<a href="https://example.com/a_(b)">site</a>');
    expect(richTextToXhtml("\\*not italic\\*")).toBe("*not italic*");
  });

  it("gives plain text and paragraphs", () => {
    expect(richTextToPlain("**A** & <b>")).toBe("A & <b>");
    expect(richTextParagraphs("a\nb\n\nc")).toEqual(["a b", "c"]);
  });
});

describe("resume to document", () => {
  it("reads dates", () => {
    expect(isoDate("Jan 2022")).toBe("2022-01");
    expect(isoDate("Sept 2020")).toBe("2020-09");
    expect(isoDate("2022")).toBe("2022");
    expect(isoDate("03/2021")).toBe("2021-03");
    expect(isoDate("2021-13")).toBe("2021");
    expect(isoDate("Present")).toBeNull();
  });

  it("formats dates and links for display", () => {
    expect(dates("Jan 2022", null, true)).toBe("Jan 2022 – Present");
    expect(dates(null, "2020", false)).toBe("2020");
    expect(dates(null, null, false)).toBeNull();
    expect(contactLink("https://www.github.com/raj/")).toEqual({ text: "github.com/raj", href: "https://www.github.com/raj/" });
  });

  it("produces a document that passes the strict document rules", () => {
    const presets = new DocPresets();
    const doc = resumeToDoc("classic", "A4", validResume());
    const result = readDoc(doc, "STRICT", presets.stylesById());
    expect(result.errors).toEqual([]);
    const sections = result.doc!.sections.map((s) => s.id);
    expect(sections).toEqual(["header", "summary", "experience", "skills"]);
    const entry = result.doc!.sections[2]!.nodes[1]!;
    expect(entry).toMatchObject({ id: "cred", role: "entry", data: { title: "Software Engineer", org: "CRED", start: "2022-01", end: null } });
  });

  it("skips hidden and empty sections and writes margins", () => {
    const data = { ...validResume(), layout: { marginTop: 10, marginLeft: 12.25 } };
    data.sections[0] = { ...data.sections[0]!, visible: false } as never;
    const doc = resumeToDoc("modern", "LETTER", data) as { page: Record<string, unknown>; sections: { id: string }[] };
    expect(doc.page).toEqual({ size: "LETTER", margin: "10mm 16mm 16mm 12.3mm" });
    expect(doc.sections.map((s) => s.id)).not.toContain("summary");
  });

  it("names downloads after the person", () => {
    expect(resumeFileName(null, validResume())).toBe("Priya Sharma - Resume.pdf");
    expect(resumeFileName("CV.PDF", validResume())).toBe("CV.pdf");
    expect(resumeFileName("", {})).toBe("Resume.pdf");
  });
});

describe("diffs", () => {
  it("describes form changes", () => {
    const before = validResume();
    const after = validResume();
    after.basics.fullName = "Priya S.";
    after.sections[1]!.entries![0]!.bullets!.push("Mentored two engineers");
    after.sections.reverse();
    const changes = resumeDiff(before, after);
    expect(changes).toEqual(expect.arrayContaining([
      { kind: "CHANGED", where: "Basics", field: "name", before: "Priya Sharma", after: "Priya S." },
      expect.objectContaining({ kind: "CHANGED", where: "Experience › Software Engineer", field: "bullets" }),
      expect.objectContaining({ kind: "MOVED", where: "Section order" }),
    ]));
  });

  it("reports added and removed sections", () => {
    const before = validResume();
    const after = validResume();
    after.sections = after.sections.filter((s) => s.id !== "skills");
    after.sections.push({ id: "awards", type: "list", title: "Awards", items: [{ text: "Hackathon winner" }] } as never);
    const kinds = resumeDiff(before, after).map((c) => `${c.kind}:${c.where}`);
    expect(kinds).toEqual(expect.arrayContaining(["ADDED:Awards", "REMOVED:Skills"]));
  });

  it("describes document changes", () => {
    const before = { schemaVersion: 3, sections: [{ id: "a", title: "About", nodes: [{ tag: "p", text: "Hello" }] }] };
    const after = { schemaVersion: 3, preset: "modern",
      sections: [{ id: "a", title: "About", nodes: [{ tag: "p", html: "Hello <b>world</b>" }] }] };
    expect(docDiff(before, after)).toEqual([
      { kind: "CHANGED", where: "Document", field: "preset", before: null, after: "modern" },
      { kind: "CHANGED", where: "About › Hello world", field: "text", before: "Hello", after: "Hello world" },
    ]);
  });
});
