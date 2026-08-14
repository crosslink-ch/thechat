import { createTransport } from "nodemailer";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function deliveryTimeoutMs() {
  const configured = Number(process.env.AUTH_CODE_DELIVERY_TIMEOUT_MS ?? 10_000);
  if (!Number.isFinite(configured)) return 10_000;
  return Math.min(30_000, Math.max(250, Math.floor(configured)));
}

async function sendViaSMTP({ to, subject, html, text }: SendEmailOptions) {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) throw new Error("SMTP_HOST not set");
  if (
    process.env.THECHAT_E2E_LOOPBACK_ONLY === "1" &&
    host !== "127.0.0.1"
  ) {
    throw new Error("Loopback-only E2E mode rejected a non-loopback SMTP host");
  }

  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SMTP_PORT is invalid");
  }
  const timeout = deliveryTimeoutMs();
  const smtpUser = process.env.SMTP_USER;
  const transport = createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true",
    auth: smtpUser
      ? {
          user: smtpUser,
          pass: process.env.SMTP_PASS,
        }
      : undefined,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  });

  try {
    await transport.sendMail({
      from: process.env.EMAIL_FROM || "noreply@thechat.app",
      to,
      subject,
      text,
      html,
    });
  } finally {
    transport.close();
  }
}

async function sendViaPostmark({ to, subject, html, text }: SendEmailOptions) {
  const token = process.env.POSTMARK_API_TOKEN;
  if (!token) throw new Error("POSTMARK_API_TOKEN not set");

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: process.env.EMAIL_FROM || "noreply@thechat.app",
      To: to,
      Subject: subject,
      TextBody: text,
      HtmlBody: html,
    }),
    signal: AbortSignal.timeout(deliveryTimeoutMs()),
  });

  if (!res.ok) {
    // Do not propagate provider response bodies; they can echo recipient data.
    throw new Error(`Postmark request failed with status ${res.status}`);
  }
}

export async function sendEmail(options: SendEmailOptions) {
  const provider = process.env.EMAIL_PROVIDER || "smtp";
  if (provider === "postmark") return sendViaPostmark(options);
  if (provider === "smtp") return sendViaSMTP(options);
  throw new Error(`Unsupported email provider: ${provider}`);
}

export async function sendVerificationCode(email: string, code: string) {
  const escapedCode = escapeHtml(code);
  // Code-only email — no clickable URL. This prevents email security scanners
  // from silently consuming verification on behalf of the user.
  await sendEmail({
    to: email,
    subject: "Your TheChat verification code",
    text: `Your TheChat verification code is: ${code}\n\nEnter this code in the app within 15 minutes.`,
    html: `
      <h2>Welcome to TheChat!</h2>
      <p>Your verification code is:</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; font-family: monospace;">${escapedCode}</p>
      <p>Enter this code in the app to verify your email. The code expires in 15 minutes.</p>
      <p>If you didn't request this, you can safely ignore this email — your address will not be verified.</p>
    `,
  });
}

export function buildPasswordResetCodeEmail(code: string) {
  const escapedCode = escapeHtml(code);
  return {
    subject: "Your TheChat password reset code",
    text: `Your TheChat password reset code is: ${code}\n\nThis code expires in 15 minutes. If you didn't request a password reset, you can safely ignore this email. Your password has not been changed.`,
    html: `
      <h2>Reset your TheChat password</h2>
      <p>Enter this code in TheChat to reset your password:</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; font-family: monospace;">${escapedCode}</p>
      <p>The code expires in 15 minutes.</p>
      <p>If you didn't request a password reset, you can safely ignore this email. Your password has not been changed.</p>
    `,
  };
}

export async function sendPasswordResetCode(email: string, code: string) {
  await sendEmail({
    to: email,
    ...buildPasswordResetCodeEmail(code),
  });
}
