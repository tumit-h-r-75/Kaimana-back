// Mongoose schema and model for "host a contest" requests. A user asks to run
// their own contests; an admin approving the request promotes them to the
// "guest" role (see modules/host/host.service.ts).

import mongoose, { model, Schema, Types } from "mongoose";

export type HostRequestStatus = "pending" | "approved" | "rejected";

export interface IHostRequest {
  userId: Types.ObjectId;
  organization: string;
  contestTitle: string;
  contestDescription: string;
  proposedStartTime?: Date;
  proposedEndTime?: Date;
  expectedParticipants?: number;
  contactEmail: string;
  message: string;
  status: HostRequestStatus;
  reviewNote?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const hostRequestSchema = new Schema<IHostRequest>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: String, default: "", trim: true },
    contestTitle: { type: String, required: true, trim: true },
    contestDescription: { type: String, required: true, trim: true },
    proposedStartTime: { type: Date },
    proposedEndTime: { type: Date },
    expectedParticipants: { type: Number },
    contactEmail: { type: String, trim: true, lowercase: true },
    message: { type: String, default: "" },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
    reviewNote: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
  },
  { timestamps: true },
);

// At most one pending request per user, enforced by the database so two
// near-simultaneous submissions can't both get in (host.service.ts maps the
// duplicate-key error to a 409). Only pending documents are in this index, so
// a user can still have any number of approved/rejected requests. `status` is
// in the key only to keep it distinct from the plain userId index above —
// every entry in the index is "pending", so it is unique on userId alone.
hostRequestSchema.index(
  { userId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_request_per_user" },
);
// Admin review queue: newest first within a status.
hostRequestSchema.index({ status: 1, createdAt: -1 });

hostRequestSchema.set("toJSON", {
  virtuals: true,
  // See Problem.model.ts for why `ret` is typed loosely here.
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const HostRequestModel = mongoose.models.HostRequest || model<IHostRequest>("HostRequest", hostRequestSchema);
