// Express router defining user analytics and performance endpoints.
import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { analyticsController } from "./analytics.controller.js";

const router = express.Router();
router.get("/me", requireAuth, analyticsController.getMine);
export const analyticsRouter = router;
