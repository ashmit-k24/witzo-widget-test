import { Router } from "express";
import { adminLoginLimiter } from "../config/rateLimiters";
import * as adminController from "../controllers/adminController";
import * as adminPlanController from "../controllers/adminPlanController";
import * as adminSettingsController from "../controllers/adminSettingsController";
import * as adminUserController from "../controllers/adminUserController";
import * as personaController from "../controllers/personaController";
import {
	adminAuth,
	requireAdminPermission,
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

router.get(
	"/me",
	adminController.getCurrentAdmin,
);
router.get(
	"/dashboard",
	requireAdminPermission("dashboard.view"),
	adminController.getDashboard,
);
router.get(
	"/insights",
	requireAdminPermission("insights.view"),
	adminController.getInsights,
);
router.get(
	"/users",
	requireAdminPermission("users.view"),
	adminController.getUsers,
);
router.get(
	"/plans",
	requireAdminPermission("plans.view"),
	adminPlanController.listPlans,
);
router.post(
	"/plans",
	requireAdminPermission("plans.manage"),
	validationRules.adminPlanUpsert,
	validate,
	adminPlanController.createPlan,
);
router.put(
	"/plans/:id",
	requireAdminPermission("plans.manage"),
	validationRules.adminPlanIdParam,
	validationRules.adminPlanUpsert,
	validate,
	adminPlanController.updatePlan,
);
router.get(
	"/admin-users",
	requireAdminPermission("admins.view"),
	adminUserController.listAdminUsers,
);

router.get(
	"/settings/disallowed-domains",
	requireAdminPermission("settings.view"),
	adminSettingsController.listDisallowedDomains,
);
router.put(
	"/settings/disallowed-domains",
	requireAdminPermission("settings.manage"),
	validationRules.adminDisallowedDomainsUpdate,
	validate,
	adminSettingsController.updateDisallowedDomains,
);
router.get(
	"/settings/personas",
	requireAdminPermission("settings.view"),
	personaController.adminListPersonas,
);
router.put(
	"/settings/personas/:personaKey",
	requireAdminPermission("settings.manage"),
	validationRules.adminPersonaParam,
	validationRules.adminPersonaUpdate,
	validate,
	personaController.adminUpdatePersona,
);
router.get(
	"/permissions",
	requireAdminPermission("admins.view"),
	adminUserController.listAdminPermissions,
);
router.post(
	"/admin-users",
	requireAdminPermission("admins.manage"),
	validationRules.adminUserCreate,
	validate,
	adminUserController.createAdminUser,
);
router.put(
	"/admin-users/:id",
	requireAdminPermission("admins.manage"),
	validationRules.adminUserIdParam,
	validationRules.adminUserUpdate,
	validate,
	adminUserController.updateAdminUser,
);
router.delete(
	"/admin-users/:id",
	requireAdminPermission("admins.manage"),
	validationRules.adminUserIdParam,
	validate,
	adminUserController.deleteAdminUser,
);

router.post(
	"/actions/reset-usage",
	requireAdminPermission("actions.reset_usage"),
	adminController.resetUsage,
);
router.post(
	"/actions/force-logout",
	requireAdminPermission("actions.force_logout"),
	adminController.forceLogout,
);
router.post(
	"/actions/set-plan",
	requireAdminPermission("actions.set_plan"),
	adminController.setUserPlan,
);

export default router;
