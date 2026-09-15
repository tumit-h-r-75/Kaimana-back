// Express router for Code Quest (Kids section) progress.
// Mounted by app.ts at /api/kids (not done here — see module handoff).

import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { kidsController } from "./kids.controller.js";

const router = express.Router();

// Progress always belongs to the signed-in learner.
router.use(requireAuth);

router.get("/progress", kidsController.getProgress);
router.put("/progress/:levelId", kidsController.saveProgress);

export const kidsRouter = router;
