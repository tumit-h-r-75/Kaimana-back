import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { submissionController } from "./submission.controller.js";

const router = express.Router();
router.post("/execute", requireAuth, submissionController.execute);
router.post("/", requireAuth, submissionController.submit);
router.get("/", requireAuth, submissionController.list);
router.get("/:id", requireAuth, submissionController.getById);
export const submissionRouter = router;
