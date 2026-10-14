import { describe, expect, it } from "vitest";

import { ashbyFetcher, greenhouseFetcher, parseBoard, workplaceFrom, type JobPosting } from "../../src/discovery/boards.js";
import { classify } from "../../src/discovery/classify.js";
import { DiscoveryService } from "../../src/discovery/discovery.js";

const posting = (id: string, title: string, extra: Partial<JobPosting> = {}): JobPosting => ({
  id, title, company: "Acme", location: "Bengaluru", department: null, workplaceType: "UNSPECIFIED",
  url: `https://jobs.example.com/${id}`, postedAt: new Date("2026-10-01T00:00:00Z"), source: "Greenhouse", techRole: null,
  ...extra,
});

describe("tech role classifier", () => {
  it("recognizes tech roles, most specific first", () => {
    expect(classify("Senior Backend Engineer", null)).toBe("BACKEND");
    expect(classify("SDET II", null)).toBe("QA");
    expect(classify("Distributed Systems Engineer", null)).toBe("BACKEND");
    expect(classify("Systems Engineer", null)).toBe("DEVOPS");
    expect(classify("Machine Learning Engineer", null)).toBe("DATA_ML");
    expect(classify("Full-Stack Developer", null)).toBe("FULL_STACK");
    expect(classify("iOS Engineer", null)).toBe("MOBILE");
    expect(classify("Software Engineer", null)).toBe("GENERAL");
    expect(classify("Staff Wizard", "Engineering")).toBe("GENERAL");
  });

  it("drops non-tech and customer-facing roles", () => {
    expect(classify("Account Executive", null)).toBeNull();
    expect(classify("Solutions Engineer", null)).toBeNull();
    expect(classify("Technical Program Manager", null)).toBeNull();
    expect(classify("Backend Engineer", "Sales")).toBeNull();
    expect(classify("Office Manager", "Operations")).toBeNull();
  });
});

describe("job boards", () => {
  it("parses board settings and refuses unsafe slugs", () => {
    expect(parseBoard(" lever:cred:CRED ")).toEqual({ provider: "LEVER", slug: "cred", companyName: "CRED" });
    expect(parseBoard("ashby:sarvam:Sarvam AI: Labs").companyName).toBe("Sarvam AI: Labs");
    expect(() => parseBoard("workday:x:Y")).toThrow(/Unknown job board provider/);
    expect(() => parseBoard("lever:../x:Y")).toThrow(/Invalid job board slug/);
    expect(() => parseBoard("lever:x")).toThrow(/Expected format/);
  });

  it("normalizes workplace values", () => {
    expect(workplaceFrom("On-site")).toBe("ONSITE");
    expect(workplaceFrom("Remote")).toBe("REMOTE");
    expect(workplaceFrom(null)).toBe("UNSPECIFIED");
  });

  it("maps Greenhouse postings", async () => {
    const urls: string[] = [];
    const fetcher = greenhouseFetcher(async (url) => {
      urls.push(String(url));
      return Response.json({ jobs: [{ id: 7, title: "Backend Engineer", location: { name: "Remote - India" },
        absolute_url: "https://boards.greenhouse.io/acme/jobs/7", first_published: "2026-09-14T03:49:28-04:00" }] });
    });
    const [job] = await fetcher({ provider: "GREENHOUSE", slug: "acme", companyName: "Acme" });
    expect(urls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs"]);
    expect(job).toMatchObject({ id: "greenhouse-acme-7", company: "Acme", workplaceType: "REMOTE", source: "Greenhouse" });
    expect(job!.postedAt?.toISOString()).toBe("2026-09-14T07:49:28.000Z");
  });

  it("skips unlisted Ashby postings", async () => {
    const fetcher = ashbyFetcher(async () => Response.json({ jobs: [
      { id: "a", title: "Engineer", isListed: false },
      { id: "b", title: "Engineer", isRemote: true },
    ] }));
    const jobs = await fetcher({ provider: "ASHBY", slug: "acme", companyName: "Acme" });
    expect(jobs.map((j) => [j.id, j.workplaceType])).toEqual([["ashby-acme-b", "REMOTE"]]);
  });
});

describe("discovery service", () => {
  const boards = [
    { provider: "GREENHOUSE" as const, slug: "acme", companyName: "Acme" },
    { provider: "LEVER" as const, slug: "beta", companyName: "Beta" },
  ];

  function service(now = { value: new Date("2026-10-14T00:00:00Z") }) {
    let calls = 0;
    const discovery = new DiscoveryService(boards, {
      GREENHOUSE: async () => {
        calls++;
        return [
          posting("1", "Backend Engineer", { postedAt: new Date("2026-10-01T00:00:00Z") }),
          posting("2", "Sales Manager"),
          posting("3", "Frontend Developer", { location: "Anywhere", workplaceType: "REMOTE", postedAt: new Date("2026-10-05T00:00:00Z") }),
        ];
      },
      LEVER: async () => {
        throw new Error("HTTP 500");
      },
    }, 15 * 60 * 1000, () => now.value);
    return { discovery, calls: () => calls, now };
  }

  it("keeps tech jobs, newest first, and reports failing boards", async () => {
    const { discovery } = service();
    const result = await discovery.search("", "", null, 100, false);
    expect(result.jobs.map((j) => j.id)).toEqual(["3", "1"]);
    expect(result.total).toBe(2);
    expect(result.roleCounts).toEqual({ BACKEND: 1, FRONTEND: 1 });
    expect(result.sources).toEqual([
      { board: "Acme (Greenhouse)", company: "Acme", provider: "Greenhouse", ok: true, count: 2, error: null },
      { board: "Beta (Lever)", company: "Beta", provider: "Lever", ok: false, count: 0, error: "Could not fetch this board right now." },
    ]);
  });

  it("filters by words, place and role", async () => {
    const { discovery } = service();
    expect((await discovery.search("backend acme", "bengaluru", null, 100, false)).total).toBe(1);
    expect((await discovery.search("", "remote", null, 100, false)).jobs.map((j) => j.id)).toEqual(["3"]);
    const frontend = await discovery.search("", "", "FRONTEND", 100, false);
    expect(frontend.jobs.map((j) => j.id)).toEqual(["3"]);
    expect(frontend.roleCounts).toEqual({ BACKEND: 1, FRONTEND: 1 });
    expect((await discovery.search("", "", null, 1, false)).jobs).toHaveLength(1);
  });

  it("caches boards for 15 minutes unless refreshed", async () => {
    const { discovery, calls, now } = service();
    await discovery.search("", "", null, 10, false);
    await discovery.search("", "", null, 10, false);
    expect(calls()).toBe(1);
    await discovery.search("", "", null, 10, true);
    expect(calls()).toBe(2);
    now.value = new Date(now.value.getTime() + 16 * 60 * 1000);
    await discovery.search("", "", null, 10, false);
    expect(calls()).toBe(3);
  });

  it("shares one fetch between concurrent searches", async () => {
    const { discovery, calls } = service();
    await Promise.all([discovery.search("", "", null, 10, false), discovery.search("", "", null, 10, false)]);
    expect(calls()).toBe(1);
  });
});
