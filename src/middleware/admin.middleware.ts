import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth.middleware.js";
import { AppError } from "../utils/errors.js";

export const requireAdmin = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  if (req.user?.role !== "admin") return next(new AppError("Administrator access is required.", 403));
  next();
};
