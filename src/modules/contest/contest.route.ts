// Express router defining coding contest endpoints.
import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { requireRoles } from "../../middleware/admin.middleware.js";
import { optionalAuth } from "../../middleware/optionalAuth.middleware.js";
import { contestController } from "./contest.controller.js";

// Admins manage every contest; guests (users whose host request was
// approved, see modules/host) only the contests they created — the service
// enforces that per contest.
const requireContestManager = requireRoles("admin", "guest");

const router = express.Router();
router.get("/", contestController.list);
// The /manage routes must stay above /:identifier, otherwise
// GET /manage is matched as a contest whose identifier is "manage".
router.get("/manage", requireAuth, requireContestManager, contestController.listManaged);
router.get("/manage/:id", requireAuth, requireContestManager, contestController.getManaged);
router.patch("/manage/:id", requireAuth, requireContestManager, contestController.updateManaged);
router.delete("/manage/:id", requireAuth, requireContestManager, contestController.deleteManaged);
router.get("/:identifier", optionalAuth, contestController.getByIdentifier);
router.get("/:identifier/scoreboard", contestController.getScoreboard);
router.post("/", requireAuth, requireContestManager, contestController.create);
router.post("/:identifier/register", requireAuth, contestController.register);
export const contestRouter = router;
