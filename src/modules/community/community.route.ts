// Express router defining public community feed and comment endpoints.
// Mounted by app.ts at /api/community (not done here — see module handoff).

import express from "express";
import { communityController } from "./community.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { optionalAuth } from "../../middleware/optionalAuth.middleware.js";

const router = express.Router();

// Public browsing — optionalAuth attaches req.user when a session is
// present, without requiring one.
router.get("/feed", optionalAuth, communityController.feed);
router.get("/submissions/:id", optionalAuth, communityController.detail);
router.get("/submissions/:id/comments", communityController.comments);

// Posting/removing comments requires a signed-in user.
router.post("/submissions/:id/comments", requireAuth, communityController.addComment);
router.delete("/comments/:id", requireAuth, communityController.deleteComment);

export const communityRouter = router;
