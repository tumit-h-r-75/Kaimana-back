// Express router defining endpoints for AI features.
import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { requireAdmin } from "../../middleware/admin.middleware.js";
import { aiController } from "./ai.controller.js";

const router = express.Router();
router.post("/hint", requireAuth, aiController.getHint);
router.post("/audit", requireAuth, aiController.runAudit);
router.post("/refactor", requireAuth, aiController.runRefactor);
router.post("/refactor/verify", requireAuth, aiController.verifyRefactor);
// Admin-only (F10): generates candidate test cases for review, not a
// learner-facing feature.
router.post("/generate-tests", requireAuth, requireAdmin, aiController.generateTests);
export const aiRouter = router;
