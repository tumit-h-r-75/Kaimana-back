// Getting mail out of the building.
//
// Two ways in. `deliver` with urgent: true sends inside the request — a
// password reset link is worthless in five minutes' time — and falls back to
// the outbox if the provider is down, so the message is retried rather than
// lost. Everything else is queued and picked up by `flush`, which runs on a
// schedule and on the back of ordinary traffic.
//
// Nothing in here throws at its caller. An account was still created, a
// proposal was still approved; failing that action because a mail server
// hiccuped would be the worse outcome. Failures are logged and recorded on
// the outbox row instead.

import { EmailOutboxModel } from "../../models/EmailOutbox.model.js";
import { mailIsConfigured, sendThroughResend, type OutgoingMail } from "../../integrations/resend/resend.service.js";
import type { BuiltMail } from "./mail.templates.js";

const MAX_ATTEMPTS = 5;
// A serverless function can be frozen between claiming a message and
// recording the result, which leaves the row in "sending" with nobody
// coming back for it. After this long, treat it as abandoned and retry.
const STUCK_AFTER_MINUTES = 5;
// Roughly a minute, then five, then a quarter of an hour, an hour, four.
// After that the row stays as `failed` for someone to look at.
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

const toOutgoing = (to: string, mail: BuiltMail): OutgoingMail => ({
  to: to.toLowerCase().trim(),
  subject: mail.subject,
  html: mail.html,
  text: mail.text,
});

/** Writes the message to the outbox for the next flush to pick up. */
const queue = async (to: string, mail: BuiltMail, sendAfter = new Date()) => {
  try {
    await EmailOutboxModel.create({ ...toOutgoing(to, mail), status: "queued", sendAfter });
    return true;
  } catch (error) {
    // The outbox itself is unreachable. There is nowhere left to put this.
    console.error("Could not queue an email:", reason(error));
    return false;
  }
};

/** Sends now; on failure leaves a queued row behind so it is retried. */
const sendNow = async (to: string, mail: BuiltMail) => {
  const outgoing = toOutgoing(to, mail);
  try {
    const providerId = await sendThroughResend(outgoing);
    // Kept as a record of what went out, and swept by the collection's TTL
    // after a month.
    await EmailOutboxModel.create({ ...outgoing, status: "sent", attempts: 1, sentAt: new Date(), providerId }).catch(() => undefined);
    return true;
  } catch (error) {
    console.error(`Sending "${mail.subject}" to ${outgoing.to} failed:`, reason(error));
    await EmailOutboxModel.create({
      ...outgoing,
      status: "queued",
      attempts: 1,
      lastError: reason(error),
      sendAfter: minutesFromNow(BACKOFF_MINUTES[0]),
    }).catch(() => undefined);
    return false;
  }
};

/**
 * The one entry point callers use.
 * `urgent` means the message is the reply to something the user just did.
 */
const deliver = (to: unknown, mail: BuiltMail, { urgent = false }: { urgent?: boolean } = {}) => {
  const address = String(to ?? "").trim();
  if (!/^\S+@\S+\.\S+$/.test(address)) return Promise.resolve(false);
  return urgent ? sendNow(address, mail) : queue(address, mail);
};

/**
 * Sends what is due. Each row is claimed with a findOneAndUpdate before it is
 * handed to the provider, so two overlapping flushes — a cron and a request
 * arriving together — cannot send the same message twice.
 */
const flush = async (limit = 10) => {
  const result = { sent: 0, failed: 0 };
  for (let i = 0; i < limit; i += 1) {
    const stuckBefore = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);
    const claimed = await EmailOutboxModel.findOneAndUpdate(
      {
        attempts: { $lt: MAX_ATTEMPTS },
        $or: [
          { status: "queued", sendAfter: { $lte: new Date() } },
          { status: "sending", updatedAt: { $lt: stuckBefore } },
        ],
      },
      { $set: { status: "sending" }, $inc: { attempts: 1 } },
      { sort: { sendAfter: 1, createdAt: 1 }, new: true },
    );
    if (!claimed) break;

    try {
      const providerId = await sendThroughResend({ to: claimed.to, subject: claimed.subject, html: claimed.html, text: claimed.text });
      await EmailOutboxModel.updateOne({ _id: claimed._id }, { $set: { status: "sent", sentAt: new Date(), providerId }, $unset: { lastError: "" } });
      result.sent += 1;
    } catch (error) {
      const attempts = claimed.attempts;
      const exhausted = attempts >= MAX_ATTEMPTS;
      await EmailOutboxModel.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: exhausted ? "failed" : "queued",
            lastError: reason(error),
            sendAfter: minutesFromNow(BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]),
          },
        },
      );
      result.failed += 1;
      console.error(`Outbox message to ${claimed.to} failed (attempt ${attempts}):`, reason(error));
      // A provider that just refused one message will usually refuse the
      // next one too; stop and let the next pass try again.
      break;
    }
  }
  return result;
};

/**
 * Best-effort drain on the back of ordinary traffic.
 *
 * Vercel's Hobby plan runs a cron once a day, which is not often enough for
 * queued mail, so a request here and there also nudges the queue along. It
 * is rate-limited per instance and never awaited by a route handler.
 */
let lastOpportunisticFlush = 0;
const OPPORTUNISTIC_GAP_MS = 60_000;
const flushInBackground = () => {
  if (Date.now() - lastOpportunisticFlush < OPPORTUNISTIC_GAP_MS) return;
  lastOpportunisticFlush = Date.now();
  void flush(5).catch((error) => console.error("Background mail flush failed:", reason(error)));
};

export const mailService = { deliver, queue, flush, flushInBackground, isConfigured: mailIsConfigured };
