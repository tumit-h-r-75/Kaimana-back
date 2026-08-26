import type { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { isDatabaseConnected } from "../config/database.js";

export const requireDatabase = (_req: Request, res: Response, next: NextFunction) => {
  if (isDatabaseConnected()) {
    return next();
  }

  return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
    success: false,
    statusCode: httpStatus.SERVICE_UNAVAILABLE,
    message: "Database is temporarily unavailable. Please try again shortly.",
  });
};
