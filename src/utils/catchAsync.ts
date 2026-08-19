// Utility function to wrap async route handlers and catch errors.

import { NextFunction, Request, RequestHandler, Response } from "express";
import httpStatus from "http-status";
import { config } from "../config/env.js";

const NODE_ENV = config.nodeEnv;

export const catchAsync = (fn: RequestHandler) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await fn(req, res, next);
        } catch (error) {
            res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
                success: false,
                statusCode: httpStatus.INTERNAL_SERVER_ERROR,
                message: "Internal server error",
                error: (error as Error).message,
                stack: NODE_ENV === "development" ? (error as Error).stack : null
            })
        }
    }
}