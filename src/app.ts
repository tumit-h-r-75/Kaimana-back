// Express application configuration, middleware setup, and route mounting.

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { config } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { authRouter } from "./modules/auth/auth.route.js";
import { authController } from "./modules/auth/auth.controller.js";
import { submissionRouter } from "./modules/submission/submission.route.js";
import { problemRouter } from "./modules/problem/problem.route.js";
import { leaderboardRouter } from "./modules/leaderboard/leaderboard.route.js";
import { aiRouter } from "./modules/ai/ai.route.js";
import { contestRouter } from "./modules/contest/contest.route.js";
import { adminRouter } from "./modules/admin/admin.route.js";
import { analyticsRouter } from "./modules/analytics/analytics.route.js";
import { interviewRouter } from "./modules/interview/interview.route.js";
import { communityRouter } from "./modules/community/community.route.js";
import { requireDatabase } from "./middleware/database.middleware.js";

const app = express();

// Middleware
app.use(
    cors({
        origin(origin, callback) {
            // Health checks and server-to-server requests have no Origin.
            // Browser requests must be explicitly listed in FRONTEND_URL.
            const normalizedOrigin = origin?.replace(/\/$/, "");
            const isLocalDevelopmentOrigin = normalizedOrigin === "http://localhost:3000" || normalizedOrigin === "http://127.0.0.1:3000";
            if (!origin || isLocalDevelopmentOrigin || config.frontendUrls.includes(normalizedOrigin ?? "")) {
                return callback(null, true);
            }

            return callback(new Error("Origin is not allowed by CORS"));
        },
        credentials: true,
    })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Kaimana Backend is running",
    });
});
app.get("/api/health", (_req, res) => {
    res.status(200).json({
        success: true,
        message: "Kaimana API is healthy",
        data: { timestamp: new Date().toISOString() },
    });
});
app.get("/health", (_req, res) => {
    res.status(200).json({ success: true, message: "Kaimana API is healthy", data: { timestamp: new Date().toISOString() } });
});

// This endpoint only returns public OAuth configuration and does not require MongoDB.
app.get("/api/auth/google/client-config", authController.googleClientConfig);

// All remaining application routes require an active database connection.
app.use(requireDatabase);
app.use("/api/auth", authRouter);
app.use("/api/problems", problemRouter);
app.use("/api/submissions", submissionRouter);
app.use("/api/leaderboard", leaderboardRouter);
app.use("/api/ai", aiRouter);
app.use("/api/contests", contestRouter);
app.use("/api/admin", adminRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/interview", interviewRouter);
app.use("/api/community", communityRouter);

// Must be LAST: catches unmatched routes, then catches all errors
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
