import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

// Vercel provides environment variables through process.env. Locally we use
// the ignored .env.local file so development secrets never enter Git.
// Load the developer-local file when present; hosted environments continue to
// use injected process.env values. `override: false` prevents local defaults
// from replacing deployment secrets.
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: false });

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  // Comma-separated origins allow production and Vercel preview deployments.
  FRONTEND_URL: optionalString,
  PISTON_URL: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  JWT_ACCESS_SECRET: z.string().min(1, "JWT_ACCESS_SECRET is required"),
  JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required"),
  JWT_ACCESS_EXPIRES_IN: z.string().min(1, "JWT_ACCESS_EXPIRES_IN is required"),
  JWT_REFRESH_EXPIRES_IN: z.string().min(1, "JWT_REFRESH_EXPIRES_IN is required"),
});

export const env = envSchema.parse(process.env);

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  mongodbUri: env.MONGODB_URI,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  frontendUrls: (env.FRONTEND_URL ?? "")
    .split(",")
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean),
  pistonUrl: env.PISTON_URL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  jwtAccessSecret: env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: env.JWT_REFRESH_SECRET,
  jwtAccessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
};
