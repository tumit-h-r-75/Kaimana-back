import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

// Vercel provides environment variables through process.env. Locally we use
// ignored .env / .env.local files so development secrets never enter Git.
// `.env` never replaces a variable that is already set (hosted deployments
// keep their injected values); `.env.local` then overrides `.env` for local
// development. Neither file is deployed.
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: false });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

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
  JUDGE0_URL: optionalString,
  // Groq (see modules/ai/ai.service.ts) is the PRIMARY AI provider — a free,
  // no-credit-card API tier with much lower latency than Gemini's free
  // tier (the reason this got added: Gemini was reported as noticeably
  // slow). When set, every AI feature calls Groq first.
  GROQ_API_KEY: optionalString,
  // Override only if the default model in ai.service.ts gets retired by
  // Groq before this code is updated — see console.groq.com/docs/deprecations.
  GROQ_MODEL: optionalString,
  // Google AI Studio key for Gemini (see modules/ai/ai.service.ts). Kept as
  // a FALLBACK provider — used only when GROQ_API_KEY isn't set, so an
  // existing Gemini setup (once its account-level access issue is
  // resolved) still works without needing Groq configured too.
  GEMINI_API_KEY: optionalString,
  // Override only if the default model in ai.service.ts gets renamed or
  // retired by Google before this code is updated — see that file's
  // comment for where to check current model names.
  GEMINI_MODEL: optionalString,
  // Avatar uploads (see services/cloudinary.service.ts). Optional — when
  // unset, registration/profile updates simply skip the image and the
  // feature degrades gracefully instead of crashing the server.
  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  // Execution Visualizer. Off unless explicitly enabled: a traced run is a
  // whole extra Judge0 submission that runs far slower than the plain one,
  // and the default judge is a shared public instance.
  FEATURE_EXECUTION_VISUALIZER: z.enum(["true", "false"]).default("false"),
  // Email (see modules/mail). Optional: with no key the mail service prints
  // messages to the log instead of sending them, so the password-reset flow
  // is still testable locally and nothing crashes in a deployment that has
  // not been given an account yet.
  RESEND_API_KEY: optionalString,
  // Brevo verifies a single sender address rather than a whole domain, so
  // it can write to anyone without one. Preferred when both are set.
  BREVO_API_KEY: optionalString,
  // Must be an address at a domain verified in Resend. Their sandbox sender
  // works without a domain but only delivers to the account owner.
  MAIL_FROM: optionalString,
  MAIL_REPLY_TO: optionalString,
  // Shared secret for the scheduled flush of the mail outbox.
  MAIL_CRON_SECRET: optionalString,
  // This API's own public address, used for one-click unsubscribe links.
  PUBLIC_API_URL: optionalString,
  JWT_ACCESS_SECRET: z.string().min(1, "JWT_ACCESS_SECRET is required"),
  JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required"),
  JWT_ACCESS_EXPIRES_IN: z.string().min(1, "JWT_ACCESS_EXPIRES_IN is required"),
  JWT_REFRESH_EXPIRES_IN: z.string().min(1, "JWT_REFRESH_EXPIRES_IN is required"),
});

export const env = envSchema.parse(process.env);

export const config = {
  nodeEnv: env.NODE_ENV,
  // Vercel sets VERCEL=1 in every deployment. NODE_ENV defaults to
  // "development" when unset, so this is the reliable "running for real
  // users" signal — see error.middleware.ts.
  isDeployed: Boolean(process.env.VERCEL),
  port: env.PORT,
  mongodbUri: env.MONGODB_URI,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  frontendUrls: (env.FRONTEND_URL ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean),
  // Falls back to Judge0's free public demo instance so code execution works
  // with zero setup (no API key). The free public Piston API this used to
  // point at went whitelist-only in Feb 2026 and excludes portfolio/personal
  // projects from that whitelist. Set JUDGE0_URL to a self-hosted or
  // RapidAPI-fronted Judge0 instance for higher/more reliable limits.
  judge0Url: env.JUDGE0_URL ?? "https://ce.judge0.com",
  groqApiKey: env.GROQ_API_KEY,
  groqModel: env.GROQ_MODEL,
  geminiApiKey: env.GEMINI_API_KEY,
  geminiModel: env.GEMINI_MODEL,
  cloudinaryCloudName: env.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: env.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: env.CLOUDINARY_API_SECRET,
  executionVisualizerEnabled: env.FEATURE_EXECUTION_VISUALIZER === "true",
  resendApiKey: env.RESEND_API_KEY,
  brevoApiKey: env.BREVO_API_KEY,
  mailFrom: env.MAIL_FROM ?? "Kaimana <onboarding@resend.dev>", // override in every deployment
  mailReplyTo: env.MAIL_REPLY_TO,
  mailCronSecret: env.MAIL_CRON_SECRET,
  publicApiUrl: env.PUBLIC_API_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined),
  jwtAccessSecret: env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: env.JWT_REFRESH_SECRET,
  jwtAccessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
};
