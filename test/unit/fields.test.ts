import { describe, expect, it } from "vitest";

import { DocPresets } from "../../src/docengine/presets.js";
import { readDoc } from "../../src/docengine/reader.js";
import { documentLink, isAcceptableWebLink } from "../../src/docengine/safe-urls.js";
import { resumeDataSchema } from "../../src/resumes/resume-data.js";
import { resumeToDoc } from "../../src/resumes/resume-to-doc.js";
import { richTextToXhtml } from "../../src/resumes/rich-text.js";
import { fieldsSchema, fillFields, resolveFields, type UserFieldService } from "../../src/users/fields.js";

const values = { github: "https://github.com/priya", leetcode: "leetcode.com/u/priya" };

describe("saved details ({{key}})", () => {
  it("fills placeholders in every string, leaving unknown ones", () => {
    const resolved = resolveFields({
      basics: { links: [{ label: "GitHub", url: "{{github}}" }] },
      sections: [{ content: "Solved 400 problems: [LeetCode]({{ leetcode }}). {{unknown}}" }],
      count: 3,
    }, values);
    expect(resolved).toEqual({
      basics: { links: [{ label: "GitHub", url: "https://github.com/priya" }] },
      sections: [{ content: "Solved 400 problems: [LeetCode](leetcode.com/u/priya). {{unknown}}" }],
      count: 3,
    });
  });

  it("skips the database when nothing uses a placeholder", async () => {
    let calls = 0;
    const service = { values: async () => { calls++; return values; } } as unknown as UserFieldService;
    expect(await fillFields(service, "u1", { text: "plain" })).toEqual({ text: "plain" });
    expect(calls).toBe(0);
    expect(await fillFields(service, "u1", { url: "{{github}}" })).toEqual({ url: "https://github.com/priya" });
    expect(calls).toBe(1);
  });

  it("accepts placeholders where links are expected", () => {
    expect(isAcceptableWebLink("{{github}}")).toBe(true);
    expect(documentLink("{{ github }}")).toBe("{{ github }}");
    expect(isAcceptableWebLink("{{bad key}}")).toBe(false);
    expect(resumeDataSchema.safeParse({ basics: { fullName: "A", links: [{ url: "{{github}}" }] } }).success).toBe(true);
    expect(richTextToXhtml("[GitHub]({{github}})")).toBe('<a href="{{github}}">GitHub</a>');
  });

  it("keeps placeholder links through the form → document conversion", () => {
    const doc = resumeToDoc("classic", "A4", { basics: { fullName: "A", links: [{ url: "{{github}}" }] }, sections: [] });
    const result = readDoc(doc, "STRICT", new DocPresets().stylesById());
    expect(result.errors).toEqual([]);
    expect(JSON.stringify(doc)).toContain('"href":"{{github}}"');
  });

  it("validates the saved list", () => {
    expect(fieldsSchema.safeParse({ fields: [{ key: "github", label: "GitHub", value: "https://github.com/x" }] }).success).toBe(true);
    expect(fieldsSchema.safeParse({ fields: [{ key: "Git Hub", label: "GitHub", value: "x" }] }).success).toBe(false);
    expect(fieldsSchema.safeParse({ fields: [{ key: "x", label: "X", value: "a\nb" }] }).success).toBe(false);
  });
});
