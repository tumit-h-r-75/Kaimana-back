// Attaches req.user when a valid session is present, but never rejects the
// request otherwise. Used on public routes (problem browsing) that only need
// to personalize the response (solvedByMe, myBestVerdict) for signed-in users.

import type { NextFunction, Response } from "express";
import { config } from "../config/env.js";
import { jwtUtils } from "../utils/jwt.js";
import type { AuthenticatedRequest } from "./auth.middleware.js";

export const optionalAuth = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const token = req.cookies?.accessToken ?? bearer;
  if (!token) return next();

  const verified = jwtUtils.verifyToken(token, config.jwtAccessSecret);
  if (verified.success && verified.data && typeof verified.data !== "string") {
    req.user = verified.data;
  }
  next();
};
