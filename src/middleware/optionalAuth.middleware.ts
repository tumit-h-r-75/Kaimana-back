// Attaches req.user when a valid session is present, but never rejects the
// request otherwise. Used on public routes (problem browsing) that only need
// to personalize the response (solvedByMe, myBestVerdict) for signed-in users.

import type { NextFunction, Response } from "express";
import { config } from "../config/env.js";
import { jwtUtils } from "../utils/jwt.js";
import type { AuthenticatedRequest } from "./auth.middleware.js";

export const optionalAuth = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  // Try every token the request carries (Bearer first, then cookie) and
  // accept whichever verifies — see the comment on requireAuth in
  // auth.middleware.ts for why picking a single source by existence alone
  // is wrong (a present-but-expired cookie can shadow a valid Bearer token).
  const candidates = [bearer, req.cookies?.accessToken].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const verified = jwtUtils.verifyToken(candidate, config.jwtAccessSecret);
    if (verified.success && verified.data && typeof verified.data !== "string") {
      req.user = verified.data;
      break;
    }
  }

  next();
};
