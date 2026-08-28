// Express router defining endpoints for stateless AI features.
import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { aiController } from "./ai.controller.js";

const router = express.Router();
router.post("/hint", requireAuth, aiController.getHint);
export const aiRouter = router;
