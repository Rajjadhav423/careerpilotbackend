import { describe, expect, it } from "vitest";

import { DocPresets } from "../../src/docengine/presets.js";
import { readDoc } from "../../src/docengine/reader.js";
import { docToResume } from "../../src/resumes/doc-to-resume.js";
import { resumeToDoc } from "../../src/resumes/resume-to-doc.js";
import { mergeDocument } from "../../src/resumes/resumes.js";
import { validResume } from "../helpers.js";

const presets = new DocPresets().stylesById();
const read = (json: unknown) => {
  const result = readDoc(json, "STRICT", presets);
  expect(result.errors).toEqual([]);
  return result.doc!;
};

describe("document → form", () => {
  it("round-trips a resume made from the form", () => {
    const original = validResume();
    const form = docToResume(read(resumeToDoc("classic", "A4", original)));
    expect(form.basics).toMatchObject({ fullName: "Priya Sharma", email: "priya@example.com" });
    expect(form.basics.links.map((l) => l.url)).toEqual(["https://github.com/priya"]);
    expect(form.sections.map((s) => [s.id, s.type])).toEqual([["summary", "text"], ["experience", "entries"], ["skills", "skills"]]);
    expect(form.sections[0]!.content).toBe("Backend engineer who likes **reliable** systems.");
    expect(form.sections[1]!.entries[0]).toMatchObject({
      id: "cred", title: "Software Engineer", subtitle: "CRED", startDate: "Jan 2022", current: true,
      bullets: ["Cut latency by *40%*", "Built [the API](https://example.com/api)"],
    });
    expect(form.sections[2]!.groups[0]).toMatchObject({ name: "Languages", keywords: ["Java", "TypeScript"] });
    expect(form.layout).toBeNull();
  });

  it("reads a hand-written document by its shape", () => {
    const form = docToResume(read({
      schemaVersion: 3, document: "resume", page: { margin: "12mm 14mm" },
      styles: { ".date": { float: "right" } },
      sections: [
        { id: "top", nodes: [
          { tag: "h1", text: "Neha Kulkarni" },
          { tag: "p", role: "contact", children: [
            { tag: "a", attrs: { href: "mailto:neha@example.com" }, text: "neha@example.com" },
            { tag: "span", text: " | " },
            { tag: "span", text: "+91 98765 43210" },
            { tag: "span", text: " | " },
            { tag: "span", text: "Mumbai" },
          ] },
        ] },
        { id: "skills", nodes: [
          { tag: "h2", text: "Skills" },
          { tag: "table", children: [{ tag: "tr", children: [{ tag: "td", text: "Frontend" }, { tag: "td", text: "React, Next.js" }] }] },
        ] },
        { id: "education", nodes: [
          { tag: "h2", text: "Education" },
          { tag: "h3", children: [{ tag: "span", text: "B.E. IT" }, { tag: "span", class: "date", text: "2017 – 2021" }] },
          { tag: "p", text: "CGPA 8.6" },
        ] },
        { id: "awards", nodes: [{ tag: "h2", text: "Awards" }, { tag: "ul", children: [{ tag: "li", text: "Hackathon winner" }] }] },
        { id: "about", nodes: [{ tag: "h2", text: "About" }, { tag: "p", html: "I like <b>clean</b> code." }] },
      ],
    }));
    expect(form.basics).toMatchObject({ fullName: "Neha Kulkarni", email: "neha@example.com", phone: "+91 98765 43210", location: "Mumbai" });
    expect(form.sections.map((s) => [s.id, s.type, s.title])).toEqual([
      ["skills", "skills", "Skills"], ["education", "entries", "Education"], ["awards", "list", "Awards"], ["about", "text", "About"],
    ]);
    expect(form.sections[0]!.groups[0]).toMatchObject({ name: "Frontend", keywords: ["React", "Next.js"] });
    expect(form.sections[1]!.entries[0]).toMatchObject({ title: "B.E. IT", startDate: "2017", endDate: "2021", description: "CGPA 8.6" });
    expect(form.sections[3]!.content).toBe("I like **clean** code.");
    expect(form.layout).toEqual({ marginTop: 12, marginRight: 14, marginBottom: 12, marginLeft: 14 });
  });
});

describe("form → document with a base document", () => {
  it("keeps the base document's styles, page settings and section styles", () => {
    const generated = resumeToDoc("modern", "LETTER", validResume());
    const base = {
      schemaVersion: 3, document: "resume", preset: "classic",
      meta: { language: "en-IN" }, page: { size: "A4", margin: "10mm", maxPages: 2, pageNumbers: false },
      styles: { ".name": { color: "#aa0000" } },
      sections: [{ id: "summary", style: { "margin-top": "20pt" }, nodes: [] }],
    };
    const merged = mergeDocument(generated, base) as Record<string, any>;
    expect(merged.preset).toBe("modern");
    expect(merged.styles).toEqual({ ".name": { color: "#aa0000" } });
    expect(merged.page).toEqual({ size: "LETTER", margin: "10mm", maxPages: 2, pageNumbers: false });
    expect(merged.meta.language).toBe("en-IN");
    expect(merged.sections.find((s: { id: string }) => s.id === "summary").style).toEqual({ "margin-top": "20pt" });
    expect(readDoc(merged, "STRICT", presets).errors).toEqual([]);
  });
});
