// Draining the mail outbox, running the scheduled mail, and the one link in
// every optional email that turns it off.
//
// A serverless function has no worker of its own, so something has to ask
// the queue to move: a scheduler (Vercel Cron, or any cron service hitting
// this URL), or an admin looking at a stuck queue.

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
import { UserModel } from "../../models/User.model.js";
import { mailService } from "./mail.service.js";
import { mailJobs } from "./mail.jobs.js";

const router = express.Router();

/**
 * Either the shared cron secret or an admin session gets in. The secret is
 * compared in full rather than short-circuiting on the first wrong
 * character, and a request with no secret configured is refused outright —
 * an unset secret must not mean "open to everyone".
 */
const allowCronOrAdmin = (req: Request, res: Response, next: NextFunction) => {
  // Vercel's own scheduler sends its secret as a bearer token and cannot add
  // custom headers, so both spellings are accepted.
  const authorization = req.header("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
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

const cron = catchAsync(async (_req, res) => {
  // The scheduled work first; whatever it queues goes out in the same call.
  const jobs = await mailJobs.runScheduled();
  const flushed = await mailService.flush(50);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Scheduled mail run.", data: { jobs, flushed } });
});

const page = (heading: string, message: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${heading}</title></head>
<body style="margin:0;background:#0A0B0D;color:#E8EAED;font:16px/1.6 Segoe UI,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:12vh auto;padding:28px;border:1px solid #242830;border-radius:16px;background:#121417;">
    <p style="margin:0;font:700 20px Segoe UI,Helvetica,Arial,sans-serif;">K<span style="color:#4FF0C5;">aimana</span></p>
    <h1 style="margin:16px 0 0;font-size:22px;">${heading}</h1>
    <p style="color:#9AA1AC;">${message}</p>
    <a href="${config.frontendUrls[0] ?? "https://kaimana.vercel.app"}/profile" style="display:inline-block;margin-top:10px;padding:12px 20px;border-radius:9px;background:#4FF0C5;color:#0A0B0D;font-weight:700;text-decoration:none;">Manage your email</a>
  </div>
</body></html>`;

/**
 * One click, from an inbox, with no session — so it is deliberately narrow:
 * a token that identifies nothing but a mailing preference, and an action
 * that can only ever turn something off.
 */
const unsubscribe = catchAsync(async (req, res) => {
  const token = String(req.query.token ?? "");
  const type = String(req.query.type ?? "");
  if (!token || !["contestReminders", "weeklyDigest"].includes(type)) {
    throw new AppError("This unsubscribe link is not valid.", 400);
  }

  const user = await UserModel.findOneAndUpdate({ unsubscribeToken: token }, { $set: { [`emailPrefs.${type}`]: false } });
  const what = type === "weeklyDigest" ? "the weekly summary" : "contest reminders";
  res
    .status(httpStatus.OK)
    .type("html")
    .send(
      user
        ? page("You are unsubscribed", `We will stop sending ${what}. Anything you ask for yourself — a password reset, for instance — still reaches you.`)
        : page("That link has already been used", "It may be from an old email. You can change any of this from your profile."),
    );
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
// What the scheduler calls: the jobs, then the queue they filled.
router.post("/cron", allowCronOrAdmin, cron);
router.get("/cron", allowCronOrAdmin, cron);
// Public by necessity — it is opened from a mail client.
router.get("/unsubscribe", unsubscribe);
router.get("/status", requireAuth, requireAdmin, status);

export const mailRouter = router;
