import { describe, expect, it } from "vitest";

import { findEmails, importJobFromUrl, isPrivateAddress, oneLine } from "../../src/jobs/import-from-url.js";

describe("isPrivateAddress", () => {
  it("blocks loopback, private, link-local and metadata addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
      "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const address of ["8.8.8.8", "104.18.2.3", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("importJobFromUrl", () => {
  it("refuses local and non-http links before fetching", async () => {
    await expect(importJobFromUrl("http://127.0.0.1:8080/api")).rejects.toMatchObject({ status: 400 });
    await expect(importJobFromUrl("http://[::1]/")).rejects.toMatchObject({ status: 400 });
    await expect(importJobFromUrl("file:///etc/passwd")).rejects.toMatchObject({ status: 400 });
  });
});

describe("findEmails", () => {
  it("keeps contact addresses and drops system ones", () => {
    expect(findEmails("Send CV to hr@acme.com or noreply@acme.com, icon@2x.png")).toEqual(["hr@acme.com"]);
  });
});

describe("oneLine", () => {
  it("keeps only the first line of a post used as a title", () => {
    expect(oneLine("Hiring: Full Stack Developer Intern\nLocation: Bangalore\nStipend: 15k")).toBe("Hiring: Full Stack Developer Intern");
    expect(oneLine("\n  Senior   Engineer  \n")).toBe("Senior Engineer");
  });
});
