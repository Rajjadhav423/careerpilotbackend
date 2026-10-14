import prismaPackage, { type Prisma as PrismaTypes, type PrismaClient as PrismaClientType } from "@prisma/client";

/*
 * PostgreSQL through Prisma (schema in prisma/schema.prisma). Every query that reads user data filters by the owner's
 * id, so one user can never see another user's rows.
 *
 * @prisma/client is CommonJS: its values are read from the default export so this works in Node's ESM loader.
 */

const { PrismaClient, Prisma } = prismaPackage;

export type Db = PrismaClientType;
/** The client inside an interactive transaction (db.$transaction(async (tx) => …)). */
export type Tx = PrismaTypes.TransactionClient;

export { Prisma };

export function createDb(url?: string): Db {
  return new PrismaClient(url ? { datasourceUrl: url } : undefined);
}

/** A nullable Json column value: SQL NULL when absent. */
export function jsonOrNull(value: unknown): PrismaTypes.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null ? Prisma.DbNull : (value as PrismaTypes.InputJsonValue);
}

export const asJson = (value: unknown) => value as PrismaTypes.InputJsonValue;
