import { createTransport } from "nodemailer";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

async function sendViaSMTP({ to, subject, html }: SendEmailOptions) {
  const transport = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transport.sendMail({
    from: process.env.EMAIL_FROM || "noreply@thechat.app",
    to,
    subject,
    html,
  });
}

async function sendViaPostmark({ to, subject, html }: SendEmailOptions) {
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
      HtmlBody: html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Postmark error: ${res.status} ${body}`);
  }
}

export async function sendEmail(options: SendEmailOptions) {
  const provider = process.env.EMAIL_PROVIDER || "smtp";

  if (provider === "postmark") {
    return sendViaPostmark(options);
  }
  return sendViaSMTP(options);
}

export async function sendVerificationEmail(email: string, token: string) {
  const baseUrl = process.env.API_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/auth/verify-email?token=${token}`;

  await sendEmail({
    to: email,
    subject: "Verify your email - TheChat",
    html: `
      <h2>Welcome to TheChat!</h2>
      <p>Click the link below to verify your email address:</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>This link expires in 24 hours.</p>
    `,
  });
}
