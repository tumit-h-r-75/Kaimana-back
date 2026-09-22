// Express router for the signed-in user's notifications. Mounted by app.ts
// at /api/notifications.

import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { notificationController } from "./notification.controller.js";

const router = express.Router();

router.get("/", requireAuth, notificationController.list);
router.post("/seen", requireAuth, notificationController.markSeen);

export const notificationRouter = router;
