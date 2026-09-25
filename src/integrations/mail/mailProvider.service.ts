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
//   Resend  — until a domain is verified, it refuses every recipient except
//             the account holder's own address. Good once a domain exists.
//   Brevo   — verifies a single sender address instead of a whole domain, so
//             mail reaches anyone from the day it is set up.
//
// Brevo wins when both are set, because "reaches everyone" beats "reaches
// one person". With neither, the message is printed to the log, so local
// development works without an account and nothing is silently dropped.

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

export type MailProvider = "brevo" | "resend" | "console";

export const activeProvider = (): MailProvider => {
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

/** Resolves with the provider's message id, or throws with its reason. */
export const sendMail = async (mail: OutgoingMail): Promise<string> => {
  switch (activeProvider()) {
    case "brevo":
      return sendThroughBrevo(mail);
    case "resend":
      return sendThroughResend(mail);
    default:
      console.info(`[mail:console] to=${mail.to} | ${mail.subject}\n${mail.text}\n`);
      return "console";
  }
};
