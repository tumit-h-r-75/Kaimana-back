// Draining the mail outbox from outside a request.
//
// A serverless function has no background worker, so something has to ask
// the queue to move: a scheduler (Vercel Cron, or any cron service hitting
// this URL), or an admin looking at a stuck queue. Both end up here.

import express from "express";
import type { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { config } from "../../config/env.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.middleware.js";
import { requireAdmin } from "../../middleware/admin.middleware.js";
import { AppError } from "../../utils/errors.js";
import { EmailOutboxModel } from "../../models/EmailOutbox.model.js";
import { mailService } from "./mail.service.js";

const router = express.Router();

/**
 * Either the shared cron secret or an admin session gets in. The secret is
 * compared in full rather than short-circuiting on the first wrong
 * character, and a request with no secret configured is refused outright —
 * an unset secret must not mean "open to everyone".
 */
const allowCronOrAdmin = (req: Request, res: Response, next: NextFunction) => {
  const bearer = req.header("authorization")?.startsWith("Bearer ") ? req.header("authorization")!.slice(7) : "";
  const presented = String(req.header("x-cron-secret") ?? bearer ?? "");
  const expected = config.mailCronSecret ?? "";
  if (expected && presented.length === expected.length) {
    let mismatch = 0;
    for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
    if (mismatch === 0) return next();
  }
  if (presented) return next(new AppError("Invalid cron secret.", httpStatus.UNAUTHORIZED));
  // No secret offered: fall through to the normal admin check.
  const authenticated = req as AuthenticatedRequest;
  return requireAuth(authenticated, res, (error?: unknown) => (error ? next(error) : requireAdmin(authenticated, res, next)));
};

const flush = catchAsync(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const result = await mailService.flush(limit);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Mail queue flushed.", data: result });
});

const status = catchAsync(async (_req, res) => {
  const [queued, failed, sent] = await Promise.all([
    EmailOutboxModel.countDocuments({ status: { $in: ["queued", "sending"] } }),
    EmailOutboxModel.countDocuments({ status: "failed" }),
    EmailOutboxModel.countDocuments({ status: "sent" }),
  ]);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Mail queue status.",
    data: { configured: mailService.isConfigured(), queued, failed, sentLast30Days: sent },
  });
});

// GET as well as POST: most cron services only send GET.
router.post("/flush", allowCronOrAdmin, flush);
router.get("/flush", allowCronOrAdmin, flush);
router.get("/status", requireAuth, requireAdmin, status);

export const mailRouter = router;
