const loopbackHosts = new Set(["127.0.0.1", "::1"]);

function requireLoopbackUrl(name: string, rawValue: string | undefined) {
  if (!rawValue) throw new Error(`${name} is required for this test suite`);
  const url = new URL(rawValue);
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(`${name} must use an explicit loopback address`);
  }
  return url;
}

export function assertDisposablePasswordResetTestEnvironment() {
  if (process.env.THECHAT_PASSWORD_RESET_TEST_DISPOSABLE !== "1") {
    throw new Error(
      "Password-reset tests require the disposable test harness; run pnpm test:api:password-reset",
    );
  }

  const databaseUrl = requireLoopbackUrl(
    "DATABASE_URL",
    process.env.DATABASE_URL,
  );
  if (!databaseUrl.pathname.endsWith("_e2e")) {
    throw new Error("DATABASE_URL must name a disposable *_e2e database");
  }

  requireLoopbackUrl("REDIS_URL", process.env.REDIS_URL);

  if (process.env.EMAIL_PROVIDER !== "smtp") {
    throw new Error("Password-reset tests require the local SMTP provider");
  }
  if (!loopbackHosts.has(process.env.SMTP_HOST ?? "")) {
    throw new Error("SMTP_HOST must be an explicit loopback address");
  }
  if (process.env.POSTMARK_API_TOKEN) {
    throw new Error("POSTMARK_API_TOKEN must not be present during these tests");
  }
  if (
    process.env.THECHAT_OTEL_ENABLED !== "false" ||
    process.env.OTEL_SDK_DISABLED !== "true"
  ) {
    throw new Error("External telemetry must be disabled during these tests");
  }
}
