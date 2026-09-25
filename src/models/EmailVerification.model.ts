// One outstanding "confirm this address" link.
//
// Same shape and the same rules as PasswordReset: only the hash of the token
// is stored, it dies on its own at expiresAt, and it is marked used the
// moment it is spent. The address is kept alongside, so a link issued before
// someone changed their email cannot verify the new one.

import mongoose, { Schema, model, type Model, type Types } from "mongoose";

export interface IEmailVerification {
  userId: Types.ObjectId;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const emailVerificationSchema = new Schema<IEmailVerification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true },
);

emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerificationModel: Model<IEmailVerification> =
  (mongoose.models.EmailVerification as Model<IEmailVerification>) ?? model<IEmailVerification>("EmailVerification", emailVerificationSchema);
