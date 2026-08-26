// Express application configuration, middleware setup, and route mounting.

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { config } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { authRouter } from "./modules/auth/auth.route.js";

const app = express();

// Middleware
app.use(
    cors({
        origin: config.frontendUrl,
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

// Mount real module routes here, e.g.
app.use("/api/auth", authRouter);

// Must be LAST: catches unmatched routes, then catches all errors
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
