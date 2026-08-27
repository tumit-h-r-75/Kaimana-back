// Express router defining authentication and authorization endpoints.

import express from "express";
import { authController } from "./auth.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.get("/google/client-config", authController.googleClientConfig);
router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/google", authController.googleAuth);
router.post("/refresh-token", authController.refreshToken);
router.post("/logout", authController.logout);
router.get("/me", requireAuth, authController.me);

export const authRouter = router;
