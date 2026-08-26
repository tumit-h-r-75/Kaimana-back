import type { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { connectDatabase, isDatabaseConnected } from "../config/database.js";

export const requireDatabase = async (_req: Request, res: Response, next: NextFunction) => {
  if (isDatabaseConnected()) {
    return next();
  }

  // A serverless instance can receive a request before its background
  // connection attempt finishes. Make one request-scoped attempt first.
  try {
    await connectDatabase();
    return next();
  } catch {
    // The response below intentionally avoids exposing database details.
  }

  return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
    success: false,
    statusCode: httpStatus.SERVICE_UNAVAILABLE,
    message: "Database is temporarily unavailable. Please try again shortly.",
  });
};
