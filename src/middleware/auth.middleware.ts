import type { NextFunction, Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";
import { config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { jwtUtils } from "../utils/jwt.js";

export type AuthenticatedRequest = Request & { user?: JwtPayload };

export const requireAuth = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const token = req.cookies?.accessToken ?? bearer;
  if (!token) return next(new AppError("Authentication is required.", 401));
  const verified = jwtUtils.verifyToken(token, config.jwtAccessSecret);
  if (!verified.success || !verified.data || typeof verified.data === "string") return next(new AppError("Invalid or expired session.", 401));
  req.user = verified.data;
  next();
};
