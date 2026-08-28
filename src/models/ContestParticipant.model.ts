// Mongoose schema and model for tracking contest registrations and participants.

import mongoose, { model, Schema, Types } from "mongoose";

export interface IContestParticipant {
  contestId: Types.ObjectId;
  userId: Types.ObjectId;
  registeredAt: Date;
}

const contestParticipantSchema = new Schema<IContestParticipant>({
  contestId: { type: Schema.Types.ObjectId, ref: "Contest", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  registeredAt: { type: Date, default: Date.now },
});

contestParticipantSchema.index({ contestId: 1, userId: 1 }, { unique: true });

contestParticipantSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ContestParticipantModel =
  mongoose.models.ContestParticipant || model<IContestParticipant>("ContestParticipant", contestParticipantSchema);
