// Express router for problem proposals (mounted at /api/proposals). Every
// route needs a signed-in user — enforced at the router level. A learner
// manages only their own proposals; listing and reviewing are admin-only.

import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { requireAdmin } from "../../middleware/admin.middleware.js";
import { proposalController } from "./proposal.controller.js";

const router = express.Router();

router.use(requireAuth);

// Declared before /:id so "me" is never read as a proposal id.
router.get("/me", proposalController.getMine);
router.post("/", proposalController.create);
router.get("/", requireAdmin, proposalController.list);
router.get("/:id", proposalController.getOne);
router.patch("/:id", proposalController.update);
router.delete("/:id", proposalController.remove);
router.post("/:id/review", requireAdmin, proposalController.review);

export const proposalRouter = router;
