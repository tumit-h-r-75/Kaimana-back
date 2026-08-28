// Express router defining problem management and testcase routes.

import express from "express";
import { problemController } from "./problem.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { requireAdmin } from "../../middleware/admin.middleware.js";
import { optionalAuth } from "../../middleware/optionalAuth.middleware.js";

const router = express.Router();

// Admin-only management list/detail. Mounted before the public "/:slug"
// route below so "admin" is never matched as a slug.
router.get("/admin/all", requireAuth, requireAdmin, problemController.listAllForAdmin);
router.get("/admin/:id", requireAuth, requireAdmin, problemController.getByIdForAdmin);
router.delete("/admin/:id", requireAuth, requireAdmin, problemController.deleteProblem);

// Public browsing. optionalAuth attaches req.user when a valid session
// cookie/bearer token is present, so solvedByMe/myBestVerdict can be filled
// in without forcing a login.
router.get("/", optionalAuth, problemController.list);
router.get("/:slug", optionalAuth, problemController.getBySlug);

// Admin-only authoring.
router.post("/", requireAuth, requireAdmin, problemController.create);
router.patch("/:id", requireAuth, requireAdmin, problemController.update);
router.post("/:id/testcases", requireAuth, requireAdmin, problemController.addTestCases);
router.get("/:id/testcases", requireAuth, requireAdmin, problemController.listTestCases);
router.patch("/testcases/:testCaseId", requireAuth, requireAdmin, problemController.updateTestCase);
router.delete("/testcases/:testCaseId", requireAuth, requireAdmin, problemController.deleteTestCase);

export const problemRouter = router;
