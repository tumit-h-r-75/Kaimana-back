// Express router defining mock interview session endpoints.
// Every route here requires an authenticated user — enforced at the
// router level, like admin.route.ts does for admin routes.

import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { interviewController } from "./interview.controller.js";

const router = express.Router();

router.use(requireAuth);

router.get("/", interviewController.list);
router.post("/", interviewController.start);
router.get("/:id", interviewController.getOne);
router.post("/:id/respond", interviewController.respond);

export const interviewRouter = router;
