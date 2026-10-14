import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Checks that a webhook really comes from Clerk. Clerk delivers webhooks through Svix, which signs
 * "<svix-id>.<svix-timestamp>.<raw body>" with HMAC-SHA256 using the endpoint's "whsec_..." secret.
 * See https://docs.svix.com/receiving/verifying-payloads/how-manual
 */

/** Rejects old (replayed) or far-future deliveries. */
export const TOLERANCE_MS = 5 * 60 * 1000;

export class SvixVerifier {
  private readonly key: Buffer;

  constructor(secret: string, private readonly now: () => number = Date.now) {
    this.key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  }

  isValid(id: string | undefined, timestamp: string | undefined, signatureHeader: string | undefined, body: string) {
    if (!id || !timestamp || !signatureHeader) return false;
    if (!/^\d+$/.test(timestamp)) return false;
    if (Math.abs(this.now() - Number(timestamp) * 1000) > TOLERANCE_MS) return false;

    const expected = Buffer.from(this.hmac(`${id}.${timestamp}.${body}`), "ascii");
    // One or more space-separated "v1,<base64 signature>" entries (several during key rotation)
    for (const entry of signatureHeader.split(" ")) {
      const comma = entry.indexOf(",");
      if (comma <= 0 || entry.slice(0, comma) !== "v1") continue;
      const given = Buffer.from(entry.slice(comma + 1), "ascii");
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
    return false;
  }

  /** "v1,<signature>" for this content (used by tests). */
  sign(id: string, timestamp: string, body: string) {
    return `v1,${this.hmac(`${id}.${timestamp}.${body}`)}`;
  }

  private hmac(content: string) {
    return createHmac("sha256", this.key).update(content, "utf8").digest("base64");
  }
}
