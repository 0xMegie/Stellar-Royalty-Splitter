import nodemailer from "nodemailer";
import logger from "../logger.js";

function createTransporter() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT ?? "587", 10);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost) {
    return null;
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
}

export function isEmailConfigured() {
  return !!process.env.SMTP_HOST;
}

export async function sendEmail({ to, subject, html, text }) {
  const transport = createTransporter();
  if (!transport) {
    logger.warn("Email transport not available; skipping send to", { to });
    return { sent: false, reason: "smtp_not_configured" };
  }

  const from = process.env.EMAIL_FROM ?? "Stellar Royalty Splitter <noreply@stellar-royalty.app>";

  try {
    const info = await transport.sendMail({ from, to, subject, html, text });
    logger.info("Email sent successfully", { to, messageId: info.messageId });
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    logger.error("Failed to send email", { to, error: error.message });
    return { sent: false, reason: error.message };
  }
}

export async function verifyConnection() {
  const transport = createTransporter();
  if (!transport) return false;

  try {
    await transport.verify();
    logger.info("SMTP connection verified successfully");
    return true;
  } catch (error) {
    logger.error("SMTP connection verification failed", { error: error.message });
    return false;
  }
}
