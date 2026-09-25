import mongoose, { model, Schema } from "mongoose";

export interface IUser {
  googleId?: string;
  passwordHash?: string;
  name: string;
  email: string;
  profilePicUrl?: string;
  role: "user" | "guest" | "admin";
  status: "active" | "blocked";
  // Lightweight reward currency, separate from a problem's score — earned
  // once per problem on first ACCEPTED (see utils/gems.ts and
  // submission.controller.ts), shown in the site header. Never goes
  // negative. Sending a problem proposal costs PROPOSAL_COST_GEMS, and a
  // rejected proposal refunds half (modules/proposal).
  gems: number;
  // Session revocation counter. Every access/refresh token carries the
  // value it was issued under (the `tv` claim, see utils/jwt.ts), so
  // incrementing this (e.g. on password change) invalidates every token
  // signed before it.
  tokenVersion: number;
  // When the user last opened their notifications; anything newer counts
  // as unread (see models/Notification.model.ts).
  notificationsSeenAt?: Date;
  // Which of the optional emails this person wants. The ones that answer
  // something they just did — a reset link, a password change — are not
  // listed here and always send.
  emailPrefs?: { contestReminders: boolean; weeklyDigest: boolean };
  // Lets an unsubscribe link work from an inbox, with no session. Random,
  // per user, and only ever turns mail off.
  unsubscribeToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    profilePicUrl: {
      type: String,
      trim: true,
    },
    passwordHash: { type: String, select: false },

    role: {
      type: String,
      enum: ["user", "guest", "admin"],
      default: "user",
    },

    status: {
      type: String,
      enum: ["active", "blocked"],
      default: "active",
    },

    gems: {
      type: Number,
      default: 0,
      min: 0,
    },

    tokenVersion: {
      type: Number,
      default: 0,
    },

    notificationsSeenAt: {
      type: Date,
    },

    emailPrefs: {
      contestReminders: { type: Boolean, default: true },
      weeklyDigest: { type: Boolean, default: true },
    },

    unsubscribeToken: { type: String, index: true, select: false },
  },
  {
    timestamps: true,
  },
);

// Login selects "+passwordHash" and register/Google sign-in hand back the
// whole document, so without this the hash was serialized into every auth
// response. `_id` is deliberately left alone — the frontend reads
// `id ?? _id` off user objects.
userSchema.set("toJSON", {
  // See Problem.model.ts for why `ret` is typed loosely here.
  transform: (_doc, ret: any) => {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

export const UserModel =
  mongoose.models.User || model<IUser>("User", userSchema);
