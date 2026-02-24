import { Router } from "express";
import * as adminController from "../controllers/adminController";
import { authenticateAdmin } from "../middleware/adminAuth";
import { validate, validationRules } from "../middleware/validator";

const router: Router = Router();

router.post(
	"/login",
	validationRules.adminLogin,
	validate,
	adminController.adminLogin,
);

router.get(
	"/dashboard",
	authenticateAdmin,
	adminController.getAdminDashboard,
);

router.get(
	"/insights",
	authenticateAdmin,
	adminController.getAdminInsights,
);

router.get(
	"/users",
	authenticateAdmin,
	adminController.getAdminUsers,
);

router.post(
	"/actions/reset-usage",
	authenticateAdmin,
	validationRules.adminUserAction,
	validate,
	adminController.resetUserUsage,
);

router.post(
	"/actions/force-logout",
	authenticateAdmin,
	validationRules.adminUserAction,
	validate,
	adminController.forceLogoutUserSessions,
);

router.post(
	"/actions/set-plan",
	authenticateAdmin,
	validationRules.adminSetPlanAction,
	validate,
	adminController.setUserPlan,
);

export default router;
