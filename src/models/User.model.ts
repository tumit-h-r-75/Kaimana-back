import mongoose, { model, Schema } from "mongoose";

export interface IUser {
  googleId?: string;
  passwordHash?: string;
  name: string;
  email: string;
  profilePicUrl?: string;
  role: "user" | "admin";
  status: "active" | "blocked";
  // Lightweight reward currency, separate from a problem's score — earned
  // once per problem on first ACCEPTED (see utils/gems.ts and
  // submission.controller.ts), shown in the site header. Never goes
  // negative; nothing spends it yet.
  gems: number;
  // Session revocation counter. Every access/refresh token carries the
  // value it was issued under (the `tv` claim, see utils/jwt.ts), so
  // incrementing this (e.g. on password change) invalidates every token
  // signed before it.
  tokenVersion: number;
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
      enum: ["user", "admin"],
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
