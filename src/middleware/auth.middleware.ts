import type { NextFunction, Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";
import { config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { jwtUtils } from "../utils/jwt.js";
import { UserModel } from "../models/User.model.js";

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
//
// role/status are re-checked against the database on every request rather
// than trusted from the token's own payload. A JWT is a signed snapshot
// taken at issuance (login/refresh/OAuth, see auth.service.ts) — it can't
// be edited after signing, so it keeps asserting whatever role/status was
// true at that moment for its entire remaining lifetime. That used to be
// the only check: requireAdmin compared against req.user.role straight
// from the token, so revoking someone's admin role (or blocking their
// account) from /admin/users had zero effect on any token they already
// held — they kept full admin API access, and a blocked account kept full
// site access, until that specific token happened to expire on its own
// (JWT_ACCESS_EXPIRES_IN). Re-fetching the live user record closes that
// window: a revoked/blocked account is locked out on its very next
// request instead of whenever its old token times out.
export const requireAuth = async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const candidates = [bearer, req.cookies?.accessToken].filter((value): value is string => Boolean(value));
  if (candidates.length === 0) return next(new AppError("Authentication is required.", 401));

  let payload: JwtPayload | undefined;
  for (const candidate of candidates) {
    const verified = jwtUtils.verifyToken(candidate, config.jwtAccessSecret);
    if (verified.success && verified.data && typeof verified.data !== "string") {
      payload = verified.data;
      break;
    }
  }
  if (!payload) return next(new AppError("Invalid or expired session.", 401));

  try {
    // UserModel resolves through the loose `mongoose.models.User || model(...)`
    // union (see the comment on this same pattern in contest.service.ts), so
    // .lean() needs the explicit cast the rest of the codebase already uses
    // for this model (auth.service.ts, admin.service.ts).
    const liveUser = (await UserModel.findById(payload._id).select("role status").lean()) as unknown as
      | { role: "user" | "admin"; status: "active" | "blocked" }
      | null;
    if (!liveUser) return next(new AppError("Invalid or expired session.", 401));
    if (liveUser.status === "blocked") return next(new AppError("This account has been blocked.", 403));

    req.user = { ...payload, role: liveUser.role };
    return next();
  } catch (error) {
    return next(error);
  }
};
