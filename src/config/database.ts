import mongoose from "mongoose";
import { env } from "./env.js";

export const connectDatabase = async (): Promise<typeof mongoose> => {
  if (!env.MONGODB_URI) {
    throw new Error("MONGODB_URI environment variable is required.");
  }

  const connection = await mongoose.connect(env.MONGODB_URI);
  console.log(`MongoDB connected: ${connection.connection.host}`);

  return connection;
};
