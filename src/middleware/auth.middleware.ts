import type { NextFunction, Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";
import { config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { jwtUtils } from "../utils/jwt.js";

export type AuthenticatedRequest = Request & { user?: JwtPayload };

// Tries every access token the request carries (Bearer header first, then
// the cookie) and accepts the first one that actually verifies, instead of
// picking a single source by existence alone. This matters because the two
// can legitimately fall out of sync — e.g. the accessToken cookie's maxAge
// (24h, see auth.controller.ts) outlives the JWT's own expiry
// (JWT_ACCESS_EXPIRES_IN, typically 15m) by design, so a *present* cookie is
// often an *expired* one. Preferring-by-existence meant a stale-but-present
// cookie permanently shadowed a perfectly valid Bearer token and the
// request failed outright — this is what caused "reload = logged out" even
// though the frontend's Bearer/refresh flow (lib/api/client.ts) was
// otherwise working correctly.
export const requireAuth = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const candidates = [bearer, req.cookies?.accessToken].filter((value): value is string => Boolean(value));
  if (candidates.length === 0) return next(new AppError("Authentication is required.", 401));

  for (const candidate of candidates) {
    const verified = jwtUtils.verifyToken(candidate, config.jwtAccessSecret);
    if (verified.success && verified.data && typeof verified.data !== "string") {
      req.user = verified.data;
      return next();
    }
  }

  return next(new AppError("Invalid or expired session.", 401));
};
