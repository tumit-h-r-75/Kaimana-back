// Mail waiting to go out, and mail that failed on the way.
//
// Nothing user-facing should fail because a mail provider had a bad minute,
// and no message should vanish because of one. Every message is written
// here first; the sender marks it sent, or records why it did not go and
// when to try again. mail.service.ts is the only thing that touches it.

import mongoose, { Schema, model, type Model } from "mongoose";

export type EmailStatus = "queued" | "sending" | "sent" | "failed";

export interface IEmailOutbox {
  to: string;
  subject: string;
  html: string;
  text: string;
  status: EmailStatus;
  attempts: number;
  /** Not before this moment — set ahead of now by the retry backoff. */
  sendAfter: Date;
  sentAt?: Date;
  lastError?: string;
  providerId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const emailOutboxSchema = new Schema<IEmailOutbox>(
  {
    to: { type: String, required: true, lowercase: true, trim: true },
    subject: { type: String, required: true },
    html: { type: String, required: true },
    text: { type: String, required: true },
    status: { type: String, enum: ["queued", "sending", "sent", "failed"], default: "queued", index: true },
    attempts: { type: Number, default: 0 },
    sendAfter: { type: Date, default: () => new Date() },
    sentAt: { type: Date },
    lastError: { type: String },
    providerId: { type: String },
  },
  { timestamps: true },
);

// What the sender asks for on every pass: the ones due, oldest first.
emailOutboxSchema.index({ status: 1, sendAfter: 1 });
// Sent mail is kept for a month so a delivery question can be answered,
// then cleared by Mongo itself.
emailOutboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const EmailOutboxModel: Model<IEmailOutbox> =
  (mongoose.models.EmailOutbox as Model<IEmailOutbox>) ?? model<IEmailOutbox>("EmailOutbox", emailOutboxSchema);
