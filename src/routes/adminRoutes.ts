import { Router } from "express";
import { adminLoginLimiter } from "../config/rateLimiters";
import * as adminController from "../controllers/adminController";
import * as adminPlanController from "../controllers/adminPlanController";
import {
	adminAuth,
	requireAdminRole,
} from "../middleware/adminAuth";
import {
	validate,
	validationRules,
} from "../middleware/validator";

const router: Router = Router();

// POST /api/admin/login — public, no auth needed
router.post(
	"/login",
	adminLoginLimiter,
	validationRules.adminLogin,
	validate,
	adminController.login,
);

// All routes below require a valid admin bearer token
router.use(adminAuth);

router.get("/me", adminController.getCurrentAdmin);
router.get("/dashboard", adminController.getDashboard);
router.get("/insights", adminController.getInsights);
router.get("/users", adminController.getUsers);
router.get("/plans", adminPlanController.listPlans);
router.post(
	"/plans",
	requireAdminRole("super_admin"),
	validationRules.adminPlanUpsert,
	validate,
	adminPlanController.createPlan,
);
router.put(
	"/plans/:id",
	requireAdminRole("super_admin"),
	validationRules.adminPlanIdParam,
	validationRules.adminPlanUpsert,
	validate,
	adminPlanController.updatePlan,
);

router.post(
	"/actions/reset-usage",
	requireAdminRole("super_admin", "ops_admin"),
	adminController.resetUsage,
);
router.post(
	"/actions/force-logout",
	requireAdminRole("super_admin", "ops_admin"),
	adminController.forceLogout,
);
router.post(
	"/actions/set-plan",
	requireAdminRole("super_admin"),
	adminController.setUserPlan,
);

export default router;
