import { randomUUID } from "node:crypto";

import type { Db, Tx } from "../db/prisma.js";

/*
 * A CareerPilot user. Accounts (passwords, Google sign-in, email verification) live in Clerk; this row links the
 * Clerk user to our data. Profile fields are copied from the Clerk session token or Clerk webhooks.
 *
 * Profile claims in the session token come from Clerk's "Customize session token" setting:
 *   {"email": "{{user.primary_email_address}}", "name": "{{user.full_name}}", "picture": "{{user.image_url}}"}
 */

export type User = {
  id: string;
  clerkUserId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  lastSignedInAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A missing (null/undefined) value keeps what we already have. */
export type ClerkProfile = { email?: string | null; name?: string | null; picture?: string | null };

/** Lower-cased and trimmed, matching the database constraint. */
export function normaliseEmail(email: string | null | undefined): string | null {
  return email == null ? null : email.trim().toLowerCase();
}

/** The profile values to store: nulls keep the current ones; the name is trimmed to 100 characters. */
export function mergeProfile(user: Pick<User, "email" | "displayName" | "avatarUrl">, profile: ClerkProfile) {
  return {
    email: profile.email == null ? user.email : normaliseEmail(profile.email),
    displayName: profile.name == null ? user.displayName : profile.name.trim().slice(0, 100),
    avatarUrl: profile.picture == null ? user.avatarUrl : profile.picture,
  };
}

export type MeResponse = Pick<User, "id" | "email" | "displayName" | "avatarUrl" | "lastSignedInAt">;

export const toMeResponse = (user: User): MeResponse => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
  lastSignedInAt: user.lastSignedInAt,
});

/**
 * Keeps our users table in step with Clerk: webhooks (upsert / sign-in / delete) and every authenticated request
 * (creates the row if its webhook hasn't arrived yet).
 */
export class UserService {
  constructor(private readonly db: Db) {}

  /** The user behind an authenticated request (Clerk subject + session-token profile claims). */
  resolve(clerkUserId: string, profile: ClerkProfile): Promise<User> {
    return this.db.$transaction((tx) => this.findOrCreate(tx, clerkUserId, profile));
  }

  /** From a Clerk "user.created" / "user.updated" webhook. */
  upsertFromClerk(clerkUserId: string, profile: ClerkProfile): Promise<User> {
    return this.resolve(clerkUserId, profile);
  }

  /** From a Clerk "session.created" webhook (a sign-in). */
  recordSignIn(clerkUserId: string, signedInAt: Date | null): Promise<User> {
    return this.db.$transaction(async (tx) => {
      await this.findOrCreate(tx, clerkUserId, {});
      return tx.user.update({ where: { clerkUserId }, data: { lastSignedInAt: signedInAt ?? new Date() } });
    });
  }

  /** From a Clerk "user.deleted" webhook. Their data goes with them (foreign keys cascade). */
  async deleteFromClerk(clerkUserId: string): Promise<boolean> {
    const { count } = await this.db.user.deleteMany({ where: { clerkUserId } });
    return count > 0;
  }

  private async findOrCreate(tx: Tx, clerkUserId: string, profile: ClerkProfile): Promise<User> {
    // Atomic "create if missing": Clerk often delivers user.created and session.created at the same moment
    await tx.$executeRaw`insert into users (id, clerk_user_id, created_at, updated_at)
      values (${randomUUID()}::uuid, ${clerkUserId}, now(), now()) on conflict (clerk_user_id) do nothing`;
    const user = await tx.user.findUniqueOrThrow({ where: { clerkUserId } });
    const next = mergeProfile(user, profile);
    if (next.email === user.email && next.displayName === user.displayName && next.avatarUrl === user.avatarUrl) {
      return user;
    }
    // Writes only the profile columns, so a concurrent sign-in update can't be overwritten
    return tx.user.update({ where: { id: user.id }, data: next });
  }
}
