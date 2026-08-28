// Express router defining coding contest endpoints.
import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { requireAdmin } from "../../middleware/admin.middleware.js";
import { optionalAuth } from "../../middleware/optionalAuth.middleware.js";
import { contestController } from "./contest.controller.js";

const router = express.Router();
router.get("/", contestController.list);
router.get("/:identifier", optionalAuth, contestController.getByIdentifier);
router.get("/:identifier/scoreboard", contestController.getScoreboard);
router.post("/", requireAuth, requireAdmin, contestController.create);
router.post("/:identifier/register", requireAuth, contestController.register);
export const contestRouter = router;
