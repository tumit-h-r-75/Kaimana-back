import mongoose, { model, Schema } from "mongoose";

export interface IUser {
  googleId: string;
  name: string;
  email: string;
  profilePicUrl?: string;
  role: "user" | "admin";
  status: "active" | "blocked";
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    googleId: {
      type: String,
      required: true,
      unique: true,
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
  },
  {
    timestamps: true,
  },
);

export const UserModel =
  mongoose.models.User || model<IUser>("User", userSchema);