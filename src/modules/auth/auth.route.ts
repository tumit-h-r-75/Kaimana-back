// Express router defining authentication and authorization endpoints.

import express from "express";
import { authController } from "./auth.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { avatarUpload } from "../../middleware/avatarUpload.middleware.js";

const router = express.Router();

router.get("/google/client-config", authController.googleClientConfig);
// avatarUpload parses an optional multipart "avatar" file plus the usual
// text fields. A plain JSON request (no file) passes straight through —
// multer only engages when the Content-Type is actually multipart/form-data.
router.post("/register", avatarUpload, authController.register);
router.post("/login", authController.login);
router.post("/google", authController.googleAuth);
router.post("/refresh-token", authController.refreshToken);
router.post("/logout", authController.logout);
router.get("/me", requireAuth, authController.me);

export const authRouter = router;
