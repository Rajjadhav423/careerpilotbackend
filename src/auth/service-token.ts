import { decodeJwt, jwtVerify } from "jose";

import type { TokenVerifier } from "./clerk.js";

/*
 * Tokens from CareerPilot's own services (the MCP server), signed with a secret shared only with this API.
 * The MCP server checks the user's OAuth token itself and then calls us with one of these, naming the Clerk user,
 * so the user's token never leaves the MCP server (MCP forbids passing it through). Short-lived and audience-bound:
 * a token minted for this API is useless anywhere else, and a token meant for anything else is refused here.
 */

export const SERVICE_TOKEN_ISSUER = "careerpilot-mcp";
export const SERVICE_TOKEN_AUDIENCE = "careerpilot-api";
/** Longest lifetime accepted, whatever the token says */
const MAX_LIFETIME_SECONDS = 300;

export function serviceTokenVerifier(secret: string): TokenVerifier {
  const key = new TextEncoder().encode(secret);
  return async (token) => {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: SERVICE_TOKEN_ISSUER,
      audience: SERVICE_TOKEN_AUDIENCE,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    });
    if (payload.exp! - payload.iat! > MAX_LIFETIME_SECONDS) throw new Error("The service token lives too long");
    if (!payload.sub!.startsWith("user_")) throw new Error("The service token doesn't name a Clerk user");
    // No profile: the user's stored name and email stay as they are
    return { subject: payload.sub!, profile: {} };
  };
}

/** Service tokens (when a secret is configured) go to their verifier; everything else to Clerk's. */
export function withServiceTokens(clerk: TokenVerifier, secret: string | null): TokenVerifier {
  if (!secret) return clerk;
  const service = serviceTokenVerifier(secret);
  return (token) => {
    let issuer: unknown;
    try {
      issuer = decodeJwt(token).iss;
    } catch {
      return clerk(token);
    }
    return issuer === SERVICE_TOKEN_ISSUER ? service(token) : clerk(token);
  };
}
