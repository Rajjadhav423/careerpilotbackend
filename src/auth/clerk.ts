import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { ApiError } from "../http/errors.js";
import type { ClerkProfile, User, UserService } from "../users/users.js";

/*
 * Every API call needs a valid Clerk session token ("Authorization: Bearer ...") except health and the Clerk
 * webhook. Checks: signature (Clerk's public keys, fetched on first use and cached), expiry, issuer and authorized
 * party. No Clerk secret is needed for this.
 */

export type VerifiedToken = { subject: string; profile: ClerkProfile };

/** Verifies a bearer token; throws when it isn't valid. Replaceable in tests. */
export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

export function clerkTokenVerifier(options: {
  issuer: string;
  jwksUrl: string;
  authorizedParties: string[];
}): TokenVerifier {
  const keys = createRemoteJWKSet(new URL(options.jwksUrl));
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, { issuer: options.issuer, clockTolerance: 5 });
    return checkClaims(payload, options.authorizedParties);
  };
}

/**
 * Clerk puts the origin that requested the token in "azp". Rejecting unknown origins stops a token issued to some
 * other site on the same Clerk instance from being replayed against our API. Tokens created outside a browser
 * (e.g. Clerk's backend API) have no azp.
 */
export function checkClaims(payload: JWTPayload, authorizedParties: string[]): VerifiedToken {
  const azp = payload.azp;
  if (azp !== undefined && (typeof azp !== "string" || !authorizedParties.includes(azp))) {
    throw new Error("The token was issued for an origin that is not allowed");
  }
  if (!payload.sub) throw new Error("The token has no subject");
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    subject: payload.sub,
    profile: { email: text(payload.email), name: text(payload.name), picture: text(payload.picture) },
  };
}

const UNAUTHORIZED = new ApiError(401, "UNAUTHORIZED", "Sign in to continue.");

/** Requires a valid token and loads (or creates) the CareerPilot user; see {@link currentUser}. */
export function requireUser(verify: TokenVerifier, users: Pick<UserService, "resolve">): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return next(UNAUTHORIZED);
    }
    let token: VerifiedToken;
    try {
      token = await verify(match[1]!);
    } catch {
      res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      return next(UNAUTHORIZED);
    }
    try {
      res.locals.user = await users.resolve(token.subject, token.profile);
      res.locals.bearerSubject = token.subject;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** The signed-in user of a request that passed {@link requireUser}. */
export function currentUser(res: Response): User {
  const user = res.locals.user as User | undefined;
  if (!user) throw UNAUTHORIZED;
  return user;
}
