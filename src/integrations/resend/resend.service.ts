// Sending mail through Resend's HTTP API.
//
// HTTP rather than SMTP on purpose: this backend runs as a serverless
// function, where an SMTP conversation is slow to open on a cold start and
// can be cut the moment the function freezes. One POST finishes inside the
// request.
//
// With no RESEND_API_KEY the message is printed instead of sent, so local
// development works without an email account — and, more importantly,
// without silently dropping mail on the floor.

import { config } from "../../config/env.js";

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export const mailIsConfigured = () => Boolean(config.resendApiKey);

/** Resolves with the provider's message id, or throws with its reason. */
export const sendThroughResend = async (mail: OutgoingMail): Promise<string> => {
  if (!config.resendApiKey) {
    console.info(`[mail:console] to=${mail.to} | ${mail.subject}\n${mail.text}\n`);
    return "console";
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
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

  // Resend answers errors as JSON with a message; anything else (a gateway
  // page, an empty body) still has to produce a usable reason for the log
  // and for the outbox row's lastError.
  const raw = await response.text();
  let parsed: { id?: string; message?: string; name?: string } = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    throw new Error(parsed.message ?? `Resend responded ${response.status} ${raw.slice(0, 200)}`);
  }
  return parsed.id ?? "sent";
};
