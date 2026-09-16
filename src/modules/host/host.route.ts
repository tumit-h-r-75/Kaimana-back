// Express router for "host a contest" requests (mounted at /api/host-requests).
// Every route needs a signed-in user — enforced at the router level — and
// listing or reviewing requests is admin-only.

import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { requireAdmin } from "../../middleware/admin.middleware.js";
import { hostController } from "./host.controller.js";

const router = express.Router();

router.use(requireAuth);

router.post("/", hostController.create);
// Declared before /:id so "me" is never read as a request id.
router.get("/me", hostController.getMine);
router.get("/", requireAdmin, hostController.list);
router.patch("/:id", requireAdmin, hostController.review);

export const hostRequestRouter = router;
