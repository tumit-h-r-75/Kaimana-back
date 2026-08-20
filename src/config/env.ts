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
