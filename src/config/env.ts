import "dotenv/config";
import { z } from "zod";

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
  JWT_SECRET: optionalString,
  FRONTEND_URL: optionalString,
  PISTON_URL: optionalString,
  ANTHROPIC_API_KEY: optionalString,
});

export const env = envSchema.parse(process.env);

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  mongodbUri: env.MONGODB_URI,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  jwtSecret: env.JWT_SECRET,
  frontendUrl: env.FRONTEND_URL,
  pistonUrl: env.PISTON_URL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
};
