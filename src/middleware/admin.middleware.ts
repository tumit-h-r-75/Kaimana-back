import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth.middleware.js";
import { AppError } from "../utils/errors.js";

export const requireAdmin = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  if (req.user?.role !== "admin") return next(new AppError("Administrator access is required.", 403));
  next();
};

// Lets the request through only when the caller's role is one of `roles`
// (e.g. requireRoles("admin", "guest") for contest management). Must run
// after requireAuth, which refreshes req.user.role from the database.
export const requireRoles =
  (...roles: string[]) =>
  (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (typeof role !== "string" || !roles.includes(role)) return next(new AppError("You don't have access to this.", 403));
    next();
  };
