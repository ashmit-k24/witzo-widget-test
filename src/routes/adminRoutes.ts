import { Router } from "express";
import * as adminController from "../controllers/adminController";
import { adminAuth } from "../middleware/adminAuth";

const router: Router = Router();

// POST /api/admin/login — public, no auth needed
router.post("/login", adminController.login);

// All routes below require a valid admin bearer token
router.use(adminAuth);

router.get("/dashboard", adminController.getDashboard);
router.get("/insights", adminController.getInsights);
router.get("/users", adminController.getUsers);

router.post("/actions/reset-usage", adminController.resetUsage);
router.post("/actions/force-logout", adminController.forceLogout);
router.post("/actions/set-plan", adminController.setUserPlan);

export default router;
