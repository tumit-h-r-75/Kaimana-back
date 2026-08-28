// Express router defining global leaderboard endpoints.
import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { leaderboardController } from "./leaderboard.controller.js";

const router = express.Router();
router.get("/", leaderboardController.getGlobal);
router.get("/me", requireAuth, leaderboardController.getMyRank);
export const leaderboardRouter = router;
