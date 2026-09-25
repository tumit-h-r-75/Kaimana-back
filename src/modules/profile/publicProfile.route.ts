// GET /api/users/:id — one solver's public page.

import express from "express";
import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { optionalAuth } from "../../middleware/optionalAuth.middleware.js";
import { publicProfileService } from "./publicProfile.service.js";

const router = express.Router();

const getProfile = catchAsync(async (req, res) => {
  const profile = await publicProfileService.getPublicProfile(req.params.id);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Solver profile.", data: profile });
});

// Signed out is fine: every number here is already public elsewhere.
router.get("/:id", optionalAuth, getProfile);

export const publicProfileRouter = router;
