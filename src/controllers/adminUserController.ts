import { NextFunction, Request, Response } from "express";
import adminAuthService, {
	ADMIN_PERMISSION_DEFINITIONS,
	AdminPermissionKey,
	AdminRole,
} from "../services/adminAuthService";

type AdminUserPayload = {
	email?: string;
	password?: string;
	role?: AdminRole;
	isActive?: boolean;
	permissionKeys?: AdminPermissionKey[] | null;
};

export const listAdminPermissions = async (
	_req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		res.json({
			data: {
				permissions: ADMIN_PERMISSION_DEFINITIONS,
			},
		});
	} catch (error) {
		next(error);
	}
};

export const listAdminUsers = async (
	_req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const admins = await adminAuthService.listAdminUsers();
		res.json({
			data: {
				admins,
			},
		});
	} catch (error) {
		next(error);
	}
};

export const createAdminUser = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const {
			email,
			password,
			role,
			isActive = true,
			permissionKeys,
		} = req.body as AdminUserPayload;
		if (!email || !password || !role) {
			res.status(400).json({
				message: "email, password, and role are required",
			});
			return;
		}

		const admin = await adminAuthService.createAdminUser({
			email,
			password,
			role,
			isActive,
			permissionKeys,
			createdBy: req.admin!.id,
		});
		await adminAuthService.recordAuditEvent({
			adminUserId: req.admin?.id,
			action: "admin.user.create",
			ipAddress: req.ip,
			userAgent: req.get("user-agent") ?? null,
			metadata: {
				targetAdminId: admin.id,
				email: admin.email,
				role: admin.role,
			},
		});

		res.status(201).json({
			data: admin,
		});
	} catch (error) {
		next(error);
	}
};

export const updateAdminUser = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { id } = req.params;
		const {
			email,
			password,
			role,
			isActive = true,
			permissionKeys,
		} = req.body as AdminUserPayload;
		if (!email || !role) {
			res.status(400).json({
				message: "email and role are required",
			});
			return;
		}

		const admin = await adminAuthService.updateAdminUser(id, {
			email,
			password,
			role,
			isActive,
			permissionKeys,
		});
		if (!admin) {
			res.status(404).json({
				message: "Admin user not found",
			});
			return;
		}

		await adminAuthService.recordAuditEvent({
			adminUserId: req.admin?.id,
			action: "admin.user.update",
			ipAddress: req.ip,
			userAgent: req.get("user-agent") ?? null,
			metadata: {
				targetAdminId: admin.id,
				email: admin.email,
				role: admin.role,
			},
		});

		res.json({
			data: admin,
		});
	} catch (error) {
		next(error);
	}
};

export const deleteAdminUser = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { id } = req.params;
		if (req.admin?.id === id) {
			res.status(400).json({
				message: "You cannot delete your own admin account",
			});
			return;
		}

		const deleted = await adminAuthService.deleteAdminUser(id);
		if (!deleted) {
			res.status(404).json({
				message: "Admin user not found",
			});
			return;
		}

		await adminAuthService.recordAuditEvent({
			adminUserId: req.admin?.id,
			action: "admin.user.delete",
			ipAddress: req.ip,
			userAgent: req.get("user-agent") ?? null,
			metadata: {
				targetAdminId: id,
			},
		});

		res.json({
			data: {
				success: true,
			},
		});
	} catch (error) {
		next(error);
	}
};
