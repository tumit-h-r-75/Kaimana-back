// Global Express middleware for handling and formatting API errors.

import { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { AppError } from "../utils/errors.js";
import { config } from "../config/env.js";

const MULTER_MESSAGES: Record<string, string> = {
    LIMIT_FILE_SIZE: "That image is too large — please use one under 4 MB.",
    LIMIT_UNEXPECTED_FILE: "Please upload a PNG, JPEG, WEBP, or GIF image.",
};

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
    } else if (err instanceof Error) {
        message = config.nodeEnv === "development" ? err.message : message;
    }

    if (config.nodeEnv === "development") {
        console.log(err);
    }

    res.status(statusCode).json({
        success: false,
        statusCode,
        message,
        ...(config.nodeEnv === "development" && err instanceof Error
            ? { stack: err.stack }
            : {}
        )
    });
}

export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
    const error = new AppError(`Route ${req.originalUrl} not found`, 404);
    next(error);
}