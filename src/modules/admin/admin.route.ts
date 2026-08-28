// Express router for the admin dashboard: stats and user management.
// Every route here requires an authenticated admin — enforced at the
// router level so no individual route can accidentally be left open.

import express from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { requireAdmin } from "../../middleware/admin.middleware.js";
import { adminController } from "./admin.controller.js";

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get("/stats", adminController.stats);
router.get("/users", adminController.listUsers);
router.patch("/users/:id", adminController.updateUser);

export const adminRouter = router;
