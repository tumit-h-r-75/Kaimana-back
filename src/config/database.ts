import mongoose from "mongoose";
import { env } from "./env.js";

let databaseConnected = false;

export const isDatabaseConnected = () => databaseConnected;

export const connectDatabase = async (): Promise<typeof mongoose> => {
  if (!env.MONGODB_URI) {
    throw new Error("MONGODB_URI environment variable is required.");
  }

  try {
    const connection = await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    });
    databaseConnected = true;
    console.log(`MongoDB connected: ${connection.connection.host}`);
    return connection;
  } catch (error) {
    databaseConnected = false;
    throw error;
  }
};
