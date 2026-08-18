import crypto from "crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db";
import { account, session, users, verification } from "../db/schema";
import { hashAuthenticationOtp, hashAuthPassword } from "./better-auth";

const passwordResetIdentifierPrefix = "forget-password-otp-";
const passwordResetAllowedAttempts = 5;

type AtomicResetHook = () => Promise<void> | void;
let afterPasswordUpdateForTests: AtomicResetHook | null = null;

export function __setAtomicPasswordResetHookForTests(
  hook: AtomicResetHook | null,
) {
  afterPasswordUpdateForTests = hook;
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(rightBuffer, Buffer.alloc(rightBuffer.length));
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseStoredOtp(value: string) {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const hash = value.slice(0, separator);
  const attempts = Number(value.slice(separator + 1));
  if (!Number.isInteger(attempts) || attempts < 0) return null;
  return { attempts, hash };
}

export async function resetHumanPasswordWithOtp(input: {
  email: string;
  code: string;
  password: string;
}) {
  const identifier = `${passwordResetIdentifierPrefix}${input.email}`;

  // Hash every submitted password before account-dependent work. Besides
  // keeping the expensive operation outside the transaction, this reduces the
  // timing gap between unknown, bot, and human-account failures.
  const [submittedOtpHash, passwordHash] = await Promise.all([
    hashAuthenticationOtp(input.code),
    hashAuthPassword(input.password),
  ]);

  return db.transaction(async (tx) => {
    const [stored] = await tx
      .select()
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .orderBy(desc(verification.createdAt), desc(verification.id))
      .limit(1)
      .for("update");

    if (!stored) return { status: "invalid" as const };

    const deleteAllCodes = () =>
      tx.delete(verification).where(eq(verification.identifier, identifier));

    if (stored.expiresAt.getTime() <= Date.now()) {
      await deleteAllCodes();
      return { status: "invalid" as const };
    }

    const parsed = parseStoredOtp(stored.value);
    if (!parsed || parsed.attempts >= passwordResetAllowedAttempts) {
      await deleteAllCodes();
      return { status: "invalid" as const };
    }

    if (!constantTimeEqual(parsed.hash, submittedOtpHash)) {
      // Better Auth can retain older rows when a code is rotated. Keep only
      // the latest row so an old code can never become active again.
      await tx
        .delete(verification)
        .where(
          and(
            eq(verification.identifier, identifier),
            ne(verification.id, stored.id),
          ),
        );
      await tx
        .update(verification)
        .set({ value: `${parsed.hash}:${parsed.attempts + 1}` })
        .where(eq(verification.id, stored.id));
      return { status: "invalid" as const };
    }

    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, input.email), eq(users.type, "human")))
      .limit(1)
      .for("update");

    if (!user) {
      await deleteAllCodes();
      return { status: "invalid" as const };
    }

    const [credential] = await tx
      .select({ id: account.id })
      .from(account)
      .where(
        and(
          eq(account.userId, user.id),
          eq(account.providerId, "credential"),
        ),
      )
      .limit(1)
      .for("update");

    if (credential) {
      await tx
        .update(account)
        .set({ password: passwordHash })
        .where(eq(account.id, credential.id));
    } else {
      await tx.insert(account).values({
        id: crypto.randomUUID(),
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: passwordHash,
      });
    }

    await tx
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, user.id));

    // Test-only fault injection proves that password mutation, session
    // revocation, and OTP consumption roll back together.
    await afterPasswordUpdateForTests?.();

    await tx.delete(session).where(eq(session.userId, user.id));
    await deleteAllCodes();

    return { status: "success" as const };
  });
}
