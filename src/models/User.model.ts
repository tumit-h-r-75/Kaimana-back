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
  },
  {
    timestamps: true,
  },
);

export const UserModel =
  mongoose.models.User || model<IUser>("User", userSchema);
