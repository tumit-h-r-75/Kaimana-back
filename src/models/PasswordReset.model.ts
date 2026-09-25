// One outstanding "forgot my password" link.
//
// The token itself is never stored — only its SHA-256 hash, the way a
// password is. A dump of this collection therefore hands an attacker
// nothing they can put in a URL. Each row dies on its own at expiresAt
// (Mongo's TTL monitor), and is marked used the moment it is spent, so a
// link that reaches someone else's inbox cannot be replayed.

import mongoose, { Schema, model, type Model, type Types } from "mongoose";

export interface IPasswordReset {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  requestedFrom?: string;
  createdAt: Date;
  updatedAt: Date;
}

const passwordResetSchema = new Schema<IPasswordReset>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    requestedFrom: { type: String },
  },
  { timestamps: true },
);

// expireAfterSeconds 0 means "delete when expiresAt passes".
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetModel: Model<IPasswordReset> =
  (mongoose.models.PasswordReset as Model<IPasswordReset>) ?? model<IPasswordReset>("PasswordReset", passwordResetSchema);
