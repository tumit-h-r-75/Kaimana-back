// Handing a message to whichever provider is configured.
//
// HTTP rather than SMTP on purpose: this backend runs as a serverless
// function, where an SMTP conversation is slow to open on a cold start and
// can be cut the moment the function freezes. One POST finishes inside the
// request.
//
// Two providers, because the choice has a real consequence for who can be
// written to:
//
//   SMTP    — an ordinary mailbox with an app password (Gmail, say). Needs
//             no domain and no new account; the slowest to open, and capped
//             by whatever the mailbox allows per day.
//   Brevo   — verifies a single sender address instead of a whole domain, so
//             mail reaches anyone from the day it is set up.
//   Resend  — until a domain is verified, it refuses every recipient except
//             the account holder's own address. Good once a domain exists.
//
// They are tried in that order, because that is the order of "can actually
// write to a stranger". With none configured the message is printed to the
// log, so local development works without an account and nothing is
// silently dropped.

import nodemailer from "nodemailer";
import { config } from "../../config/env.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const TIMEOUT_MS = 10_000;

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** A failure the provider will repeat however many times we ask. */
export class PermanentMailError extends Error {
  readonly permanent = true;
}

export type MailProvider = "smtp" | "brevo" | "resend" | "console";

export const activeProvider = (): MailProvider => {
  if (config.smtp) return "smtp";
  if (config.brevoApiKey) return "brevo";
  if (config.resendApiKey) return "resend";
  return "console";
};

export const mailIsConfigured = () => activeProvider() !== "console";

/** "Kaimana <no-reply@example.com>" -> { name, email } */
const splitFrom = (value: string) => {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1] || "Kaimana", email: match[2].trim() };
  return { name: "Kaimana", email: value.trim() };
};

// 4xx is the provider saying no — a bad key, an unverified sender, a
// recipient the account is not allowed to write to. 408 and 429 are the
// exceptions: those mean "not now", not "never".
const failureFor = (status: number, reason: string) => {
  const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return permanent ? new PermanentMailError(reason) : new Error(reason);
};

const readBody = async (response: Response) => {
  const raw = await response.text();
  try {
    return { raw, parsed: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
  } catch {
    return { raw, parsed: {} as Record<string, unknown> };
  }
};

const sendThroughResend = async (mail: OutgoingMail): Promise<string> => {
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.mailFrom,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(config.mailReplyTo ? { reply_to: config.mailReplyTo } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const { raw, parsed } = await readBody(response);
  if (!response.ok) {
    throw failureFor(response.status, String(parsed.message ?? `Resend responded ${response.status} ${raw.slice(0, 200)}`));
  }
  return String(parsed.id ?? "sent");
};

const sendThroughBrevo = async (mail: OutgoingMail): Promise<string> => {
  const sender = splitFrom(config.mailFrom);
  const response = await fetch(BREVO_ENDPOINT, {
    method: "POST",
    headers: { "api-key": String(config.brevoApiKey), "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender,
      to: [{ email: mail.to }],
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text,
      ...(config.mailReplyTo ? { replyTo: { email: config.mailReplyTo } } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const { raw, parsed } = await readBody(response);
  if (!response.ok) {
    const message = String(parsed.message ?? `Brevo responded ${response.status} ${raw.slice(0, 200)}`);
    throw failureFor(response.status, message);
  }
  return String(parsed.messageId ?? "sent");
};

/**
 * One connection per message. Pooling a transport is pointless here: a
 * serverless instance is frozen between requests, and a socket it was
 * holding is dead by the time the next one arrives.
 */
const sendThroughSmtp = async (mail: OutgoingMail): Promise<string> => {
  const smtp = config.smtp;
  if (!smtp) throw new PermanentMailError("SMTP is not configured.");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    // 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS.
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  try {
    const info = await transport.sendMail({
      from: config.mailFrom,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(config.mailReplyTo ? { replyTo: config.mailReplyTo } : {}),
    });
    return info.messageId ?? "sent";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A rejected login or a refused sender will be refused identically next
    // time; a dropped connection is worth retrying.
    const code = (error as { responseCode?: number }).responseCode ?? 0;
    throw code >= 500 && code < 600 ? new PermanentMailError(reason) : new Error(reason);
  } finally {
    transport.close();
  }
};

/** Resolves with the provider's message id, or throws with its reason. */
export const sendMail = async (mail: OutgoingMail): Promise<string> => {
  switch (activeProvider()) {
    case "smtp":
      return sendThroughSmtp(mail);
    case "brevo":
      return sendThroughBrevo(mail);
    case "resend":
      return sendThroughResend(mail);
    default:
      console.info(`[mail:console] to=${mail.to} | ${mail.subject}\n${mail.text}\n`);
      return "console";
  }
};
