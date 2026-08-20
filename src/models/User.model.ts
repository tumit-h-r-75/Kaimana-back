import { model, models, Schema } from "mongoose";

export interface User {
  googleId: string;
  name: string;
  email: string;
  profilePicUrl?: string;
  role: "user" | "admin";
  status: "active" | "blocked";
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<User>(
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
    profilePicUrl: String,
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
  { timestamps: true },
);

export const UserModel = models.User || model<User>("User", userSchema);
