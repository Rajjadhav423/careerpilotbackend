import { describe, expect, it } from "vitest";

import { JobSearch, type DiscoverQuery } from "../../src/discovery/job-search.js";
import type { RawPosting, Source } from "../../src/discovery/sources.js";

const source = (key: string, kind: Source["kind"] = "company"): Source =>
  ({ key, provider: key, board: key, company: "Acme", kind });

const raw = (id: string, title: string, extra: Partial<RawPosting> = {}): RawPosting => ({
  id, title, company: "Acme", location: "Bengaluru, India", department: null, workplaceType: "UNSPECIFIED",
  url: `https://jobs.example.com/${id}`, postedAt: "2026-10-01T00:00:00.000Z", source: "Greenhouse", skills: [], ...extra,
});

const query = (extra: Partial<DiscoverQuery> = {}): DiscoverQuery => ({
  q: "", location: "", country: null, city: null, remote: false, from: null, to: null, role: null, hasEmail: false, resumeSkills: null, limit: 100, ...extra,
});

function setup() {
  const now = { value: new Date("2026-10-14T00:00:00Z") };
  const calls: string[] = [];
  const search = new JobSearch({
    list: () => [source("greenhouse:acme"), source("remotive", "feed"), source("broken", "feed")],
    load: async (key) => {
      calls.push(key);
      if (key === "broken") throw new Error("HTTP 500");
      if (key === "remotive") {
        return [
          raw("r1", "Frontend Developer", { location: "Anywhere", workplaceType: "REMOTE", postedAt: "2026-10-05T00:00:00.000Z" }),
          // Same job as g1 on another source: merged, the company board wins
          raw("r2", "Backend Engineer", { url: "https://remotive.com/2", source: "Remotive" }),
        ];
      }
      return [raw("g1", "Backend Engineer"), raw("g2", "Sales Manager"), raw("g3", "iOS Engineer", { location: "Tokyo, Japan", contactEmail: "jobs@acme.com" })];
    },
  }, () => now.value);
  return { search, calls, now };
}

describe("job search", () => {
  it("keeps tech jobs, merges duplicates, and reports failing sources", async () => {
    const { search, calls } = setup();
    const result = await search.search(query());
    expect(result.jobs.map((j) => j.id)).toEqual(["r1", "g1", "g3"]);
    expect(result.jobs.find((j) => j.id === "g1")?.alsoOn).toEqual(["Remotive"]);
    expect(result.sources.find((s) => s.board === "broken")).toMatchObject({ ok: false, count: 0 });
    expect(result.facets.countries).toEqual([{ name: "India", count: 1 }, { name: "Japan", count: 1 }]);
  });

  it("filters by country, city, remote, role and posting date", async () => {
    const { search } = setup();
    expect((await search.search(query({ country: "Japan" }))).jobs.map((j) => j.id)).toEqual(["g3"]);
    expect((await search.search(query({ country: "India", city: "Bengaluru" }))).jobs.map((j) => j.id)).toEqual(["g1"]);
    expect((await search.search(query({ remote: true }))).jobs.map((j) => j.id)).toEqual(["r1"]);
    expect((await search.search(query({ role: "MOBILE" }))).jobs.map((j) => j.id)).toEqual(["g3"]);
    expect((await search.search(query({ from: new Date("2026-10-03T00:00:00Z") }))).jobs.map((j) => j.id)).toEqual(["r1"]);
    const withEmail = await search.search(query({ hasEmail: true }));
    expect(withEmail.jobs.map((j) => j.id)).toEqual(["g3"]);
    expect(withEmail.facets.withEmail).toBe(1);
  });

  it("caches each source, re-fetches on refresh at most once a minute", async () => {
    const { search, calls, now } = setup();
    await search.search(query());
    await search.search(query());
    expect(calls.filter((k) => k === "greenhouse:acme")).toHaveLength(1);
    await search.search(query(), true);
    await search.search(query(), true);
    expect(calls.filter((k) => k === "greenhouse:acme")).toHaveLength(2);
    now.value = new Date(now.value.getTime() + 16 * 60 * 1000);
    await search.search(query());
    expect(calls.filter((k) => k === "greenhouse:acme")).toHaveLength(3);
  });
});

describe("hiring email in a post", () => {
  it("finds the first real hiring address and skips no-reply, privacy and placeholders", async () => {
    const { findEmail } = await import("../../src/discovery/sources.js");
    expect(findEmail("Questions: privacy@acme.com. Apply: careers [at] acme [dot] com")).toBe("careers@acme.com");
    expect(findEmail("noreply@acme.com, eeocompliance@acme.com, hr.dataprivacy@acme.com, jane@example.com")).toBeNull();
    expect(findEmail("accessibleinterviewing@acme.com, securityreporting@acme.com, acesstmt@acme.com")).toBeNull();
    expect(findEmail("Email people@acme.ai.Please include a CV")).toBe("people@acme.ai");
    expect(findEmail("Send CV to HR@Acme.io.")).toBe("hr@acme.io");
    expect(findEmail("careers@acme.com.acme or hr@acme.co.uk")).toBe("careers@acme.com");
    expect(findEmail("Write to hr@acme.co.uk")).toBe("hr@acme.co.uk");
  });
});

describe("resume match", () => {
  it("reads skills from text, with aliases and without false hits", async () => {
    const { extractSkills } = await import("../../src/discovery/skills.js");
    expect(extractSkills("Senior NodeJS / TypeScript engineer, Postgres, k8s on AWS")).toEqual(
      ["TypeScript", "Node.js", "PostgreSQL", "AWS", "Kubernetes"]);
    expect(extractSkills("JavaScript developer")).toEqual(["JavaScript"]);
    expect(extractSkills("Rest of the team will express trust; spring 2027 start")).toEqual([]);
  });

  it("sorts by match and lists matched and missing skills", async () => {
    const search = new JobSearch({
      list: () => [source("greenhouse:acme")],
      load: async () => [
        raw("a", "Backend Engineer", { skills: ["Java", "Kafka", "AWS"], postedAt: "2026-10-09T00:00:00.000Z" }),
        raw("b", "Node.js Developer", { skills: ["Node.js", "TypeScript"] }),
        raw("c", "Software Engineer"),
      ],
    }, () => new Date("2026-10-14T00:00:00Z"));
    const result = await search.search(query({ resumeSkills: ["Node.js", "TypeScript", "AWS"] }));
    expect(result.jobs.map((j) => [j.id, j.match?.score ?? null])).toEqual([["b", 100], ["a", 33], ["c", null]]);
    expect(result.jobs[1]!.match).toMatchObject({ matched: ["AWS"], missing: ["Java", "Kafka"] });
    expect(result.resumeSkills).toEqual(["Node.js", "TypeScript", "AWS"]);
  });
});
