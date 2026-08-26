import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { submissionController } from "./submission.controller.js";

const router = express.Router();
router.post("/execute", requireAuth, submissionController.execute);
export const submissionRouter = router;
