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

export async function sendVerificationCode(email: string, code: string) {
  // Code-only email — no clickable URL. This prevents email security scanners
  // (Outlook Safe Links, Mimecast, ProofPoint, etc.) from silently consuming
  // the verification on behalf of the user. The recipient must read the code
  // and type it into the app.
  await sendEmail({
    to: email,
    subject: "Your TheChat verification code",
    html: `
      <h2>Welcome to TheChat!</h2>
      <p>Your verification code is:</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; font-family: monospace;">${code}</p>
      <p>Enter this code in the app to verify your email. The code expires in 15 minutes.</p>
      <p>If you didn't request this, you can safely ignore this email — your address will not be verified.</p>
    `,
  });
}
