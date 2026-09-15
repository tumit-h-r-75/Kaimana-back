// Attaches req.user when a valid session is present, but never rejects the
// request otherwise. Used on public routes (problem browsing) that only need
// to personalize the response (solvedByMe, myBestVerdict) for signed-in users.
//
// A token that doesn't verify, belongs to a missing or blocked account, or
// was revoked by a tokenVersion bump (see requireAuth) is treated exactly
// like no token at all — the request simply continues anonymously.

import type { NextFunction, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";
import { config } from "../config/env.js";
import { jwtUtils } from "../utils/jwt.js";
import { UserModel } from "../models/User.model.js";
import type { AuthenticatedRequest } from "./auth.middleware.js";

export const optionalAuth = async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  // Try every token the request carries (Bearer first, then cookie) and
  // accept whichever verifies — see the comment on requireAuth in
  // auth.middleware.ts for why picking a single source by existence alone
  // is wrong (a present-but-expired cookie can shadow a valid Bearer token).
  const candidates = [bearer, req.cookies?.accessToken].filter((value): value is string => Boolean(value));

  const payloads: JwtPayload[] = [];
  for (const candidate of candidates) {
    const verified = jwtUtils.verifyToken(candidate, config.jwtAccessSecret);
    if (verified.success && verified.data && typeof verified.data !== "string") {
      payloads.push(verified.data);
    }
  }
  if (payloads.length === 0) return next();

  try {
    const liveUser = (await UserModel.findById(payloads[0]._id).select("role status tokenVersion").lean()) as unknown as
      | { role: "user" | "guest" | "admin"; status: "active" | "blocked"; tokenVersion?: number }
      | null;
    if (liveUser && liveUser.status !== "blocked") {
      const payload = payloads.find(
        (candidate) => String(candidate._id) === String(payloads[0]._id) && jwtUtils.tokenVersionMatches(candidate, liveUser),
      );
      if (payload) req.user = { ...payload, role: liveUser.role };
    }
  } catch {
    // A failed lookup (e.g. a malformed _id claim) just means anonymous.
  }

  next();
};
