import crypto from "crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey, defaultKeyHasher } from "@better-auth/api-key";
import { bearer, emailOTP } from "better-auth/plugins";
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";
import * as schema from "../db/schema";
import { log } from "../logging";
import { sendPasswordResetCode, sendVerificationCode } from "./email";

const INTERNAL_AUTH_PATH = "/_better-auth";
const DEFAULT_BETTER_AUTH_SECRET =
  "dev-insecure-better-auth-secret-do-not-use-in-production";
const authLog = log.child({ component: "auth" });

type VerificationCodeSender = (email: string, otp: string) => Promise<void>;
let verificationCodeSender: VerificationCodeSender = sendVerificationCode;
type PasswordResetCodeSender = (email: string, otp: string) => Promise<void>;
let passwordResetCodeSender: PasswordResetCodeSender = sendPasswordResetCode;
const pendingAuthenticationCodeDeliveries = new Set<Promise<void>>();
const maximumPendingAuthenticationCodeDeliveries = 25;

function authenticationCodeDeliveryTimeoutMs() {
  const configured = Number(process.env.AUTH_CODE_DELIVERY_TIMEOUT_MS ?? 10_000);
  if (!Number.isFinite(configured)) return 10_000;
  return Math.min(30_000, Math.max(250, Math.floor(configured)));
}

async function deliverAuthenticationCode(
  sender: VerificationCodeSender,
  email: string,
  otp: string,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sender(email, otp),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Authentication code delivery timed out")),
          authenticationCodeDeliveryTimeoutMs(),
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function drainAuthenticationCodeDeliveries(
  timeoutMs = 10_000,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...pendingAuthenticationCodeDeliveries]),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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

// Test seam: password-reset tests capture the outbound OTP without invoking a
// real SMTP or Postmark transport.
export function __setPasswordResetCodeSenderForTests(
  sender: PasswordResetCodeSender | null,
) {
  passwordResetCodeSender = sender ?? sendPasswordResetCode;
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
export const BOT_API_KEY_CONFIG_ID = "bot";
export const BOT_API_KEY_PREFIX = "bot_";
export const BOT_API_KEY_HASHER = defaultKeyHasher;

export function generateBotApiKey(): string {
  return `${BOT_API_KEY_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
}

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

function authenticationOtpHmacKey() {
  const dedicatedPepper = process.env.BETTER_AUTH_OTP_PEPPER?.trim();
  if (dedicatedPepper) return dedicatedPepper;

  // A domain-separated subkey prevents the low-entropy OTP space from being
  // enumerable by anyone who can read the verification table. Deployments may
  // provide a dedicated pepper without making it a rollout prerequisite.
  return crypto
    .createHmac("sha256", betterAuthSecret())
    .update("thechat:better-auth:email-otp-pepper:v1")
    .digest();
}

export async function hashAuthenticationOtp(otp: string) {
  return crypto
    .createHmac("sha256", authenticationOtpHmacKey())
    .update(otp)
    .digest("hex");
}

export function hashAuthPassword(password: string) {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyAuthPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash);
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
      "/email-otp/request-password-reset": false,
      "/email-otp/reset-password": false,
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification,
    autoSignIn: !requireEmailVerification,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    password: {
      hash: hashAuthPassword,
      verify: ({ password, hash }) => verifyAuthPassword(password, hash),
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
    apiKey({
      configId: BOT_API_KEY_CONFIG_ID,
      defaultPrefix: BOT_API_KEY_PREFIX,
      defaultKeyLength: 64,
      customKeyGenerator: generateBotApiKey,
      requireName: false,
      references: "user",
      rateLimit: { enabled: false },
      keyExpiration: {
        defaultExpiresIn: null,
        disableCustomExpiresTime: true,
      },
      enableMetadata: false,
      enableSessionForAPIKeys: false,
    }),
    emailOTP({
      otpLength: 6,
      expiresIn: 15 * 60,
      allowedAttempts: 5,
      storeOTP: { hash: hashAuthenticationOtp },
      resendStrategy: "rotate",
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp, type }) {
        const delivery = verificationDeliveryContext.getStore();
        if (delivery) delivery.attempted = true;
        const sender =
          type === "forget-password"
            ? passwordResetCodeSender
            : verificationCodeSender;
        const deliver = async () => {
          let lastError: unknown;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              await deliverAuthenticationCode(sender, email, otp);
              return;
            } catch (error) {
              lastError = error;
            }
          }
          if (delivery) delivery.failed = true;
          authLog.error(
            {
              errorClass:
                lastError instanceof Error
                  ? lastError.constructor.name
                  : "UnknownError",
              otpType: type,
            },
            "Failed to send authentication code after bounded retry",
          );
        };

        if (type === "forget-password") {
          // Reset requests cannot await provider I/O because latency would reveal
          // account existence. Keep a bounded queue, timeout, retry, and shutdown
          // drain rather than creating untracked promises without backpressure.
          if (
            pendingAuthenticationCodeDeliveries.size >=
            maximumPendingAuthenticationCodeDeliveries
          ) {
            if (delivery) delivery.failed = true;
            authLog.error(
              { otpType: type },
              "Authentication code delivery queue is full",
            );
            return;
          }
          const task = deliver();
          pendingAuthenticationCodeDeliveries.add(task);
          void task.finally(() => {
            pendingAuthenticationCodeDeliveries.delete(task);
          });
          return;
        }

        await deliver();
        // Verification registration/resend intentionally awaits delivery so its
        // public wrapper can return a sanitized retryable failure to that user.
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
