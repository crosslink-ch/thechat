import crypto from "crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";
import * as schema from "../db/schema";
import { log } from "../logging";
import { sendVerificationCode } from "./email";

const INTERNAL_AUTH_PATH = "/_better-auth";
const DEFAULT_BETTER_AUTH_SECRET =
  "dev-insecure-better-auth-secret-do-not-use-in-production";
const authLog = log.child({ component: "auth" });

type VerificationCodeSender = (email: string, otp: string) => Promise<void>;
let verificationCodeSender: VerificationCodeSender = sendVerificationCode;

type VerificationDeliveryContext = {
  attempted: boolean;
  failed: boolean;
};
const verificationDeliveryContext =
  new AsyncLocalStorage<VerificationDeliveryContext>();

// Test seam: OTP tests observe the delivered code here instead of reading the
// irreversibly hashed value from the verification table.
export function __setVerificationCodeSenderForTests(
  sender: VerificationCodeSender | null,
) {
  verificationCodeSender = sender ?? sendVerificationCode;
}

export function isEmailVerificationRequired() {
  return process.env.REQUIRE_EMAIL_VERIFICATION === "true";
}

export function betterAuthBaseURL() {
  const baseURL =
    process.env.BETTER_AUTH_URL ??
    process.env.THECHAT_BACKEND_URL ??
    `http://localhost:${Number(process.env.THECHAT_BACKEND_PORT) || 3000}`;
  return baseURL.replace(/\/+$/, "");
}

export const BETTER_AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function betterAuthRequestURL(path: string) {
  return `${betterAuthBaseURL()}${INTERNAL_AUTH_PATH}${path}`;
}

function betterAuthSecret() {
  const configuredSecret = process.env.BETTER_AUTH_SECRET;
  if (configuredSecret) return configuredSecret;

  if (process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }

  authLog.warn(
    "BETTER_AUTH_SECRET is not set; using an insecure development-only fallback",
  );
  return DEFAULT_BETTER_AUTH_SECRET;
}

const requireEmailVerification = isEmailVerificationRequired();

export const auth = betterAuth({
  baseURL: betterAuthBaseURL(),
  basePath: INTERNAL_AUTH_PATH,
  secret: betterAuthSecret(),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
      user: schema.users,
    },
  }),
  user: {
    modelName: "users",
    fields: {
      image: "avatar",
      emailVerified: "emailVerified",
    },
    additionalFields: {
      type: {
        type: ["human", "bot"],
        required: true,
        defaultValue: "human",
        input: false,
      },
    },
  },
  session: {
    modelName: "session",
    expiresIn: BETTER_AUTH_SESSION_MAX_AGE_SECONDS,
    updateAge: 60 * 60 * 24,
  },
  account: {
    modelName: "account",
  },
  verification: {
    modelName: "verification",
  },
  rateLimit: {
    enabled:
      process.env.NODE_ENV === "production" ||
      process.env.BETTER_AUTH_RATE_LIMIT_ENABLED === "true",
    storage: "database",
    modelName: "rateLimit",
    // The public resend route uses an outer shared DB limiter before
    // any account lookup so unknown and known emails have identical 429s.
    customRules: {
      "/email-otp/send-verification-otp": false,
      "/email-otp/verify-email": false,
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification,
    autoSignIn: !requireEmailVerification,
    password: {
      hash: (password) =>
        Bun.password.hash(password, { algorithm: "argon2id" }),
      verify: ({ password, hash }) => Bun.password.verify(password, hash),
    },
  },
  emailVerification: {
    autoSignInAfterVerification: true,
  },
  advanced: {
    ipAddress: {
      // External client headers are never copied directly to this name. The
      // Elysia wrapper resolves the peer/trusted-proxy address and injects it.
      ipAddressHeaders: ["x-thechat-client-ip"],
    },
    database: {
      generateId: ({ model }) => {
        if (model === "user" || model === "users") return false;
        return crypto.randomUUID();
      },
    },
  },
  plugins: [
    bearer(),
    emailOTP({
      otpLength: 6,
      expiresIn: 15 * 60,
      allowedAttempts: 5,
      storeOTP: "hashed",
      resendStrategy: "rotate",
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp }) {
        const delivery = verificationDeliveryContext.getStore();
        if (delivery) delivery.attempted = true;
        try {
          await verificationCodeSender(email, otp);
        } catch (error) {
          if (delivery) delivery.failed = true;
          authLog.error({ err: error }, "Failed to send verification code");
          // Better Auth intentionally swallows background-task failures. The
          // public wrapper reads the request-scoped result and returns
          // a sanitized retryable 503 instead of falsely claiming delivery.
        }
      },
    }),
  ],
});

export async function handleBetterAuthRequest(request: Request) {
  const delivery: VerificationDeliveryContext = {
    attempted: false,
    failed: false,
  };
  const response = await verificationDeliveryContext.run(delivery, () =>
    auth.handler(request),
  );
  return {
    response,
    verificationDeliveryAttempted: delivery.attempted,
    verificationDeliveryFailed: delivery.failed,
  };
}
