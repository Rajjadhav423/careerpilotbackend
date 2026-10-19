import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { SERVICE_TOKEN_AUDIENCE, SERVICE_TOKEN_ISSUER, serviceTokenVerifier, withServiceTokens } from "../../src/auth/service-token.js";

const SECRET = "s".repeat(40);
const key = (secret = SECRET) => new TextEncoder().encode(secret);

async function token(overrides: { sub?: string; aud?: string; iss?: string; lifetime?: number; secret?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(overrides.sub ?? "user_123")
    .setIssuer(overrides.iss ?? SERVICE_TOKEN_ISSUER)
    .setAudience(overrides.aud ?? SERVICE_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.lifetime ?? 60))
    .sign(key(overrides.secret));
}

describe("service tokens", () => {
  const verify = serviceTokenVerifier(SECRET);

  it("accepts a short-lived token for this API naming a Clerk user, with no profile", async () => {
    await expect(verify(await token())).resolves.toEqual({ subject: "user_123", profile: {} });
  });

  it("refuses the wrong secret, audience, issuer, a long lifetime and a non-Clerk subject", async () => {
    await expect(verify(await token({ secret: "x".repeat(40) }))).rejects.toThrow();
    await expect(verify(await token({ aud: "somewhere-else" }))).rejects.toThrow();
    await expect(verify(await token({ iss: "someone-else" }))).rejects.toThrow();
    await expect(verify(await token({ lifetime: 3600 }))).rejects.toThrow(/too long/);
    await expect(verify(await token({ sub: "admin" }))).rejects.toThrow(/Clerk user/);
  });

  it("sends service tokens to their verifier and everything else to Clerk's", async () => {
    const clerk = async () => ({ subject: "from-clerk", profile: {} });
    const both = withServiceTokens(clerk, SECRET);
    await expect(both(await token())).resolves.toMatchObject({ subject: "user_123" });
    await expect(both("not-a-jwt")).resolves.toMatchObject({ subject: "from-clerk" });
    // Without a secret, a service-looking token is just another token for Clerk to reject
    await expect(withServiceTokens(clerk, null)(await token())).resolves.toMatchObject({ subject: "from-clerk" });
  });
});
