// Global Express middleware for handling and formatting API errors.

import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { MulterError } from "multer";
import { AppError } from "../utils/errors.js";
import { config } from "../config/env.js";

const MULTER_MESSAGES: Record<string, string> = {
    LIMIT_FILE_SIZE: "That image is too large — please use one under 4 MB.",
    LIMIT_UNEXPECTED_FILE: "Please upload a PNG, JPEG, WEBP, or GIF image.",
};

const isDuplicateKeyError = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;

// Raw messages and stack traces are for local debugging only. The deployed API
// was running with NODE_ENV unset/"development", so every error response
// shipped a stack trace with server file paths — never do that on Vercel.
const showErrorDetails = config.nodeEnv === "development" && !config.isDeployed;

export const errorHandler = (err: unknown, req: Request, res: Response, next: NextFunction) => {
    let statusCode = 500;
    let message = "Internal Server Error";

    if (err instanceof AppError) {
        statusCode = err.statusCode;
        message = err.message;
    } else if (err instanceof MulterError) {
        // Thrown by avatarUpload.middleware.ts (file too large, or a
        // non-image mimetype rejected by its fileFilter).
        statusCode = 400;
        message = MULTER_MESSAGES[err.code] ?? "Could not process the uploaded file.";
    } else if (typeof err === "object" && err !== null && (err as { type?: unknown }).type === "entity.parse.failed") {
        // express.json() rejects a malformed JSON body before any route runs.
        statusCode = 400;
        message = "The request body is not valid JSON.";
    } else if (err instanceof mongoose.Error.CastError) {
        // A malformed id or value reaching a query (e.g. GET
        // /api/submissions/abc) is a bad request, not a server crash.
        statusCode = 400;
        message = err.kind === "ObjectId" ? "Invalid id." : `Invalid value for ${err.path}.`;
    } else if (err instanceof mongoose.Error.ValidationError) {
        statusCode = 400;
        message = Object.values(err.errors).map((fieldError) => fieldError.message).join(" ") || "Invalid data.";
    } else if (isDuplicateKeyError(err)) {
        statusCode = 409;
        message = "That record already exists.";
    } else if (err instanceof Error) {
        message = showErrorDetails ? err.message : message;
    }

    if (config.nodeEnv === "development" || statusCode >= 500) {
        console.log(err);
    }

    res.status(statusCode).json({
        success: false,
        statusCode,
        message,
        ...(showErrorDetails && err instanceof Error
            ? { stack: err.stack }
            : {}
        )
    });
}

export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
    const error = new AppError(`Route ${req.originalUrl} not found`, 404);
    next(error);
}
