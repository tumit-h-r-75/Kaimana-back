import mongoose from "mongoose";
import dns from "node:dns";
import { env } from "./env.js";

let databaseConnected = false;
let connectionPromise: Promise<typeof mongoose> | undefined;

export const isDatabaseConnected = () => databaseConnected;

export const connectDatabase = async (): Promise<typeof mongoose> => {
  if (!env.MONGODB_URI) {
    throw new Error("MONGODB_URI environment variable is required.");
  }

  if (mongoose.connection.readyState === 1) {
    databaseConnected = true;
    return mongoose;
  }
  if (connectionPromise) return connectionPromise;

  // Some serverless/Vercel runtimes cannot resolve MongoDB SRV records with
  // the platform DNS resolver. Use public resolvers for the SRV lookup.
  dns.setServers(["1.1.1.1", "8.8.8.8"]);

  connectionPromise = mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    }).then((connection) => {
      databaseConnected = true;
      console.log(`MongoDB connected: ${connection.connection.host}`);
      return connection;
    }).catch((error) => {
      databaseConnected = false;
      connectionPromise = undefined;
      throw error;
    });
  return connectionPromise;
};
