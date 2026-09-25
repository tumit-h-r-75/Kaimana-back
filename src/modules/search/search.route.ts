// GET /api/search?q= — what the command palette calls.

import express from "express";
import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/response.js";
import { optionalAuth } from "../../middleware/optionalAuth.middleware.js";
import { searchService } from "./search.service.js";

const router = express.Router();

const search = catchAsync(async (req, res) => {
  const results = await searchService.searchEverything(req.query.q);
  sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Search results.", data: results });
});

// Signed out is fine: everything returned is already public.
router.get("/", optionalAuth, search);

export const searchRouter = router;
