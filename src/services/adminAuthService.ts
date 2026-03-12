import crypto from "crypto";
import pool from "../config/database";
import { config } from "../config/env";
import logger from "../utils/logger";

const ADMIN_USERS_CACHE_TTL_MS = 60_000;
const PASSWORD_HASH_ALGORITHM = "pbkdf2_sha512";
const PASSWORD_HASH_ITERATIONS = 210_000;
const PASSWORD_HASH_KEY_LENGTH = 64;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;
const SUPPORTED_ADMIN_ROLES = [
	"super_admin",
	"ops_admin",
	"support_admin",
] as const;
export const ADMIN_PERMISSION_DEFINITIONS = [
	{ key: "dashboard.view", label: "Dashboard Overview", category: "overview" },
	{ key: "insights.view", label: "Insights Pages", category: "overview" },
	{ key: "users.view", label: "View Users", category: "users" },
	{ key: "actions.reset_usage", label: "Reset User Usage", category: "users" },
	{ key: "actions.force_logout", label: "Force User Logout", category: "users" },
	{ key: "actions.set_plan", label: "Change User Plan", category: "users" },
	{ key: "plans.view", label: "View Plans", category: "billing" },
	{ key: "plans.manage", label: "Manage Plans", category: "billing" },
	{ key: "settings.view", label: "View Settings", category: "settings" },
	{ key: "settings.manage", label: "Manage Settings", category: "settings" },
	{ key: "admins.view", label: "View Admin Accounts", category: "admins" },
	{ key: "admins.manage", label: "Manage Admin Accounts", category: "admins" },
] as const;
const ADMIN_PERMISSION_KEYS = ADMIN_PERMISSION_DEFINITIONS.map(
	(permission) => permission.key,
);
const DEFAULT_ROLE_PERMISSIONS: Record<AdminRole, readonly string[]> = {
	super_admin: ADMIN_PERMISSION_KEYS,
	ops_admin: [
		"dashboard.view",
		"insights.view",
		"users.view",
		"actions.reset_usage",
		"actions.force_logout",
		"plans.view",
		"settings.view",
	],
	support_admin: [
		"dashboard.view",
		"users.view",
		"actions.force_logout",
		"settings.view",
	],
};

export type AdminRole =
	(typeof SUPPORTED_ADMIN_ROLES)[number];
export type AdminPermissionKey =
	(typeof ADMIN_PERMISSION_DEFINITIONS)[number]["key"];
export type AdminPermissionDefinition =
	(typeof ADMIN_PERMISSION_DEFINITIONS)[number];

export interface AdminUser {
	id: string;
	email: string;
	role: AdminRole;
	isActive: boolean;
	lastLoginAt: string | null;
	permissions: AdminPermissionKey[];
	hasCustomPermissions: boolean;
	createdBy: string | null;
}

type AdminUserRow = {
	id: string;
	email: string;
	password_hash: string;
	role: AdminRole;
	is_active: boolean;
	failed_login_attempts: number;
	locked_until: Date | null;
	last_login_at: Date | null;
	permissions: unknown;
	created_by: string | null;
};

type LoginAuditContext = {
	ipAddress?: string | null;
	userAgent?: string | null;
};

type AdminLoginResult =
	| {
			success: true;
			admin: AdminUser;
	  }
	| {
			success: false;
			status: 401 | 423 | 500;
			message: string;
	  };

type AdminAccountInput = {
	email: string;
	password?: string;
	role: AdminRole;
	isActive: boolean;
	permissionKeys?: AdminPermissionKey[] | null;
};

let schemaReadyCache:
	| {
			checkedAt: number;
			value: boolean;
	  }
	| null = null;

const normalizeEmail = (value: string): string =>
	value.trim().toLowerCase();

const safeTimingEqual = (
	left: string,
	right: string,
): boolean => {
	const leftBuffer = Buffer.from(left, "utf-8");
	const rightBuffer = Buffer.from(right, "utf-8");

	if (
		leftBuffer.length !== rightBuffer.length
	) {
		return false;
	}

	return crypto.timingSafeEqual(
		leftBuffer,
		rightBuffer,
	);
};

const createPasswordHash = (
	password: string,
): string => {
	const salt = crypto
		.randomBytes(16)
		.toString("base64url");
	const derivedKey = crypto
		.pbkdf2Sync(
			password,
			salt,
			PASSWORD_HASH_ITERATIONS,
			PASSWORD_HASH_KEY_LENGTH,
			"sha512",
		)
		.toString("base64url");

	return [
		PASSWORD_HASH_ALGORITHM,
		String(PASSWORD_HASH_ITERATIONS),
		salt,
		derivedKey,
	].join("$");
};

const verifyPasswordHash = (
	password: string,
	storedHash: string,
): boolean => {
	const [
		algorithm,
		iterationsRaw,
		salt,
		expectedHash,
	] = storedHash.split("$");

	if (
		algorithm !== PASSWORD_HASH_ALGORITHM ||
		!salt ||
		!expectedHash
	) {
		return false;
	}

	const iterations = Number(iterationsRaw);
	if (!Number.isFinite(iterations) || iterations <= 0) {
		return false;
	}

	const actualHash = crypto
		.pbkdf2Sync(
			password,
			salt,
			iterations,
			PASSWORD_HASH_KEY_LENGTH,
			"sha512",
		)
		.toString("base64url");

	return safeTimingEqual(actualHash, expectedHash);
};

const isLegacyPlaintextPasswordMatch = (
	password: string,
	storedHash: string,
): boolean => {
	if (!storedHash || storedHash.includes("$")) {
		return false;
	}

	return safeTimingEqual(password, storedHash);
};

const normalizePermissionKeys = (
	rawPermissions: unknown,
): AdminPermissionKey[] => {
	if (!Array.isArray(rawPermissions)) {
		return [];
	}

	return rawPermissions
		.filter(
			(permission): permission is AdminPermissionKey =>
				typeof permission === "string" &&
				(ADMIN_PERMISSION_KEYS as readonly string[]).includes(
					permission,
				),
		)
		.sort();
};

const getEffectivePermissionKeys = (
	role: AdminRole,
	customPermissions: unknown,
): AdminPermissionKey[] => {
	if (role === "super_admin") {
		return [...ADMIN_PERMISSION_KEYS];
	}

	const normalizedCustomPermissions =
		normalizePermissionKeys(customPermissions);
	if (normalizedCustomPermissions.length > 0) {
		return normalizedCustomPermissions;
	}

	return [
		...(DEFAULT_ROLE_PERMISSIONS[role] as AdminPermissionKey[]),
	];
};

const toAdminUser = (
	admin: Pick<
		AdminUserRow,
		| "id"
		| "email"
		| "role"
		| "is_active"
		| "last_login_at"
		| "permissions"
		| "created_by"
	>,
): AdminUser => ({
	id: admin.id,
	email: admin.email,
	role: admin.role,
	isActive: admin.is_active,
	lastLoginAt: admin.last_login_at
		? admin.last_login_at.toISOString()
		: null,
	permissions: getEffectivePermissionKeys(
		admin.role,
		admin.permissions,
	),
	hasCustomPermissions:
		Array.isArray(admin.permissions) &&
		admin.permissions.length > 0,
	createdBy: admin.created_by ?? null,
});

const isAdminTableMissingError = (
	error: unknown,
): boolean => {
	const maybePgError = error as {
		code?: string;
		message?: string;
	};

	return (
		maybePgError?.code === "42P01" ||
		maybePgError?.message?.includes(
			"relation \"admin_users\" does not exist",
		) === true
	);
};

const isLegacyAdminConfigured = (): boolean =>
	Boolean(
		config.ADMIN_EMAIL.trim() &&
			config.ADMIN_PASSWORD.trim(),
	);

const isSchemaReady = async (): Promise<boolean> => {
	const now = Date.now();
	if (
		schemaReadyCache &&
		now - schemaReadyCache.checkedAt <
			ADMIN_USERS_CACHE_TTL_MS
	) {
		return schemaReadyCache.value;
	}

	try {
		const result = await pool.query<{
			admin_users_exists: string | null;
			admin_audit_logs_exists: string | null;
		}>(`
			SELECT
				to_regclass('public.admin_users')::text AS admin_users_exists,
				to_regclass('public.admin_audit_logs')::text AS admin_audit_logs_exists
		`);

		const ready = Boolean(
			result.rows[0]?.admin_users_exists &&
				result.rows[0]?.admin_audit_logs_exists,
		);
		schemaReadyCache = {
			checkedAt: now,
			value: ready,
		};
		return ready;
	} catch (error) {
		logger.warn(
			"Failed to inspect admin auth schema state",
			{
				error:
					error instanceof Error
						? error.message
						: String(error),
			},
		);
		return false;
	}
};

const ensureBootstrapAdmin = async (): Promise<void> => {
	if (
		!(await isSchemaReady()) ||
		!isLegacyAdminConfigured()
	) {
		if (!(await isSchemaReady())) {
			logger.debug(
				"Admin bootstrap skipped because admin auth schema is not ready",
			);
		} else if (!isLegacyAdminConfigured()) {
			logger.warn(
				"Admin bootstrap skipped because ADMIN_EMAIL or ADMIN_PASSWORD is not configured",
			);
		}
		return;
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const countResult = await client.query<{
			total: string;
		}>("SELECT COUNT(*) AS total FROM admin_users");

		if (Number(countResult.rows[0]?.total ?? 0) > 0) {
			await client.query("COMMIT");
			return;
		}

		await client.query(
			`
				INSERT INTO admin_users (
					email,
					password_hash,
					role,
					is_active,
					password_changed_at
				)
				VALUES ($1, $2, 'super_admin', TRUE, NOW())
			`,
			[
				normalizeEmail(config.ADMIN_EMAIL),
				createPasswordHash(config.ADMIN_PASSWORD),
			],
		);

		await client.query("COMMIT");
		logger.warn(
			"Bootstrapped initial admin user from environment variables. Rotate credentials and move to managed admin accounts after first login.",
			{
				email: normalizeEmail(config.ADMIN_EMAIL),
			},
		);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
};

const syncLegacyAdminRecord = async (): Promise<void> => {
	if (!(await isSchemaReady()) || !isLegacyAdminConfigured()) {
		return;
	}

	await pool.query(
		`
			INSERT INTO admin_users (
				email,
				password_hash,
				role,
				is_active,
				failed_login_attempts,
				locked_until,
				password_changed_at
			)
			VALUES ($1, $2, 'super_admin', TRUE, 0, NULL, NOW())
			ON CONFLICT ((LOWER(email))) DO UPDATE
			SET
				password_hash = EXCLUDED.password_hash,
				is_active = TRUE,
				failed_login_attempts = 0,
				locked_until = NULL,
				password_changed_at = NOW(),
				updated_at = NOW()
		`,
		[
			normalizeEmail(config.ADMIN_EMAIL),
			createPasswordHash(config.ADMIN_PASSWORD),
		],
	);
};

const initializeAdminAuth = async (): Promise<void> => {
	try {
		await ensureBootstrapAdmin();
	} catch (error) {
		logger.error("Failed to initialize admin authentication", {
			error:
				error instanceof Error
					? error.message
					: String(error),
		});
	}
};

const getAdminByIdentity = async (
	identity: {
		adminId?: string;
		email?: string;
	},
): Promise<AdminUser | null> => {
	if (!(await isSchemaReady())) {
		return null;
	}

	const clauses: string[] = [];
	const params: string[] = [];

	if (identity.adminId) {
		params.push(identity.adminId);
		clauses.push(`id = $${params.length}`);
	}

	if (identity.email) {
		params.push(normalizeEmail(identity.email));
		clauses.push(`LOWER(email) = $${params.length}`);
	}

	if (clauses.length === 0) {
		return null;
	}

	const result = await pool.query<AdminUserRow>(
		`
			SELECT
				id,
				email,
				password_hash,
				role,
				is_active,
				failed_login_attempts,
				locked_until,
				last_login_at,
				permissions,
				created_by
			FROM admin_users
			WHERE ${clauses.join(" OR ")}
			ORDER BY id
			LIMIT 1
		`,
		params,
	);

	const admin = result.rows[0];
	if (!admin || !admin.is_active) {
		return null;
	}

	return toAdminUser(admin);
};

const recordAuditEvent = async ({
	adminUserId,
	action,
	ipAddress,
	userAgent,
	metadata,
}: {
	adminUserId?: string | null;
	action: string;
	ipAddress?: string | null;
	userAgent?: string | null;
	metadata?: Record<string, unknown>;
}): Promise<void> => {
	if (!(await isSchemaReady())) {
		return;
	}

	try {
		await pool.query(
			`
				INSERT INTO admin_audit_logs (
					admin_user_id,
					action,
					metadata,
					ip_address,
					user_agent
				)
				VALUES ($1, $2, $3::jsonb, $4, $5)
			`,
			[
				adminUserId ?? null,
				action,
				JSON.stringify(metadata ?? {}),
				ipAddress ?? null,
				userAgent ?? null,
			],
		);
	} catch (error) {
		if (isAdminTableMissingError(error)) {
			schemaReadyCache = {
				checkedAt: Date.now(),
				value: false,
			};
			return;
		}

		logger.warn("Failed to persist admin audit event", {
			action,
			error:
				error instanceof Error
					? error.message
					: String(error),
		});
	}
};

const authenticateWithDatabase = async (
	email: string,
	password: string,
	context: LoginAuditContext,
): Promise<AdminLoginResult> => {
	await ensureBootstrapAdmin();

	const normalizedEmail = normalizeEmail(email);
	const result = await pool.query<AdminUserRow>(
		`
			SELECT
				id,
				email,
				password_hash,
				role,
				is_active,
				failed_login_attempts,
				locked_until,
				last_login_at,
				permissions,
				created_by
			FROM admin_users
			WHERE LOWER(email) = $1
			LIMIT 1
		`,
		[normalizedEmail],
	);

	const admin = result.rows[0];
	if (!admin || !admin.is_active) {
		await recordAuditEvent({
			action: "admin.login.failed",
			ipAddress: context.ipAddress,
			userAgent: context.userAgent,
			metadata: {
				email: normalizedEmail,
				reason: "not_found_or_inactive",
			},
		});
		return {
			success: false,
			status: 401,
			message: "Invalid credentials",
		};
	}

	if (
		admin.locked_until &&
		admin.locked_until.getTime() > Date.now()
	) {
		await recordAuditEvent({
			adminUserId: admin.id,
			action: "admin.login.locked",
			ipAddress: context.ipAddress,
			userAgent: context.userAgent,
			metadata: {
				email: normalizedEmail,
				lockedUntil: admin.locked_until.toISOString(),
			},
		});
		return {
			success: false,
			status: 423,
			message:
				"Account temporarily locked. Please try again later.",
		};
	}

	const passwordMatches = verifyPasswordHash(
		password,
		admin.password_hash,
	);
	const plaintextPasswordMatches =
		!passwordMatches &&
		isLegacyPlaintextPasswordMatch(
			password,
			admin.password_hash,
		);

	if (!passwordMatches && !plaintextPasswordMatches) {
		const nextFailedAttempts =
			admin.failed_login_attempts + 1;
		const shouldLock =
			nextFailedAttempts >= MAX_FAILED_LOGIN_ATTEMPTS;
		const lockedUntil = shouldLock
			? new Date(
					Date.now() +
						LOCKOUT_DURATION_MINUTES *
							60 *
							1000,
			  )
			: null;

		await pool.query(
			`
				UPDATE admin_users
				SET
					failed_login_attempts = $1,
					locked_until = $2
				WHERE id = $3
			`,
			[
				nextFailedAttempts,
				lockedUntil,
				admin.id,
			],
		);

		await recordAuditEvent({
			adminUserId: admin.id,
			action: "admin.login.failed",
			ipAddress: context.ipAddress,
			userAgent: context.userAgent,
			metadata: {
				email: normalizedEmail,
				reason: shouldLock
					? "password_invalid_account_locked"
					: "password_invalid",
				failedAttempts: nextFailedAttempts,
			},
		});

		return shouldLock
			? {
					success: false,
					status: 423,
					message:
						"Account temporarily locked. Please try again later.",
			  }
			: {
					success: false,
					status: 401,
					message: "Invalid credentials",
			  };
	}

	await pool.query(
		`
			UPDATE admin_users
			SET
				password_hash = $2,
				failed_login_attempts = 0,
				locked_until = NULL,
				last_login_at = NOW(),
				password_changed_at = CASE
					WHEN password_changed_at IS NULL OR password_hash <> $2
					THEN NOW()
					ELSE password_changed_at
				END
			WHERE id = $1
		`,
		[
			admin.id,
			passwordMatches
				? admin.password_hash
				: createPasswordHash(password),
		],
	);

	const authenticatedAdmin: AdminUser = {
		...toAdminUser(admin),
		lastLoginAt: new Date().toISOString(),
	};

	await recordAuditEvent({
		adminUserId: admin.id,
		action: "admin.login.success",
		ipAddress: context.ipAddress,
		userAgent: context.userAgent,
		metadata: {
			email: normalizedEmail,
			role: admin.role,
		},
	});

	return {
		success: true,
		admin: authenticatedAdmin,
	};
};

const authenticateAdmin = async (
	email: string,
	password: string,
	context: LoginAuditContext,
): Promise<AdminLoginResult> => {
	try {
		const normalizedEmail = normalizeEmail(email);
		if (!(await isSchemaReady())) {
			await recordAuditEvent({
				action: "admin.login.failed",
				ipAddress: context.ipAddress,
				userAgent: context.userAgent,
				metadata: {
					email: normalizedEmail,
					reason: "admin_auth_schema_not_ready",
				},
			});
			return {
				success: false,
				status: 500,
				message:
					"Admin authentication is not initialized. Run database migrations and provision an admin user.",
			};
		}

		const loginResult = await authenticateWithDatabase(
			email,
			password,
			context,
		);
		if (loginResult.success) {
			return loginResult;
		}

		const isLegacyCredentialMatch =
			loginResult.status === 401 &&
			isLegacyAdminConfigured() &&
			normalizedEmail ===
				normalizeEmail(config.ADMIN_EMAIL) &&
			password === config.ADMIN_PASSWORD;

		if (!isLegacyCredentialMatch) {
			return loginResult;
		}

		await syncLegacyAdminRecord();
		return authenticateWithDatabase(
			email,
			password,
			context,
		);
	} catch (error) {
		if (isAdminTableMissingError(error)) {
			schemaReadyCache = {
				checkedAt: Date.now(),
				value: false,
			};
			return {
				success: false,
				status: 500,
				message:
					"Admin authentication is not initialized. Run database migrations and provision an admin user.",
			};
		}

		logger.error("Admin authentication failed", {
			error:
				error instanceof Error
					? error.message
					: String(error),
		});
		return {
			success: false,
			status: 500,
			message:
				"Unable to complete admin authentication",
		};
	}
};

const resolveAuthenticatedAdmin = async (
	identity: {
		adminId?: string;
		email?: string;
	},
): Promise<AdminUser | null> => {
	try {
		return await getAdminByIdentity(identity);
	} catch (error) {
		if (isAdminTableMissingError(error)) {
			schemaReadyCache = {
				checkedAt: Date.now(),
				value: false,
			};
			return getAdminByIdentity(identity);
		}

		logger.error("Failed to resolve admin from token", {
			error:
				error instanceof Error
					? error.message
					: String(error),
		});
		return null;
	}
};

const listAdminUsers = async (): Promise<AdminUser[]> => {
	const result = await pool.query<AdminUserRow>(
		`
			SELECT
				id,
				email,
				password_hash,
				role,
				is_active,
				failed_login_attempts,
				locked_until,
				last_login_at,
				permissions,
				created_by
			FROM admin_users
			ORDER BY created_at ASC, email ASC
		`,
	);

	return result.rows.map((row) => toAdminUser(row));
};

const createAdminUser = async (
	input: AdminAccountInput & { createdBy: string },
): Promise<AdminUser> => {
	const normalizedEmail = normalizeEmail(input.email);
	if (!input.password) {
		throw new Error("Password is required");
	}

	const permissionKeys =
		input.role === "super_admin"
			? null
			: normalizePermissionKeys(input.permissionKeys);

	const result = await pool.query<AdminUserRow>(
		`
			INSERT INTO admin_users (
				email,
				password_hash,
				role,
				is_active,
				password_changed_at,
				permissions,
				created_by
			)
			VALUES ($1, $2, $3, $4, NOW(), $5::jsonb, $6)
			RETURNING
				id,
				email,
				password_hash,
				role,
				is_active,
				failed_login_attempts,
				locked_until,
				last_login_at,
				permissions,
				created_by
		`,
		[
			normalizedEmail,
			createPasswordHash(input.password),
			input.role,
			input.isActive,
			permissionKeys ? JSON.stringify(permissionKeys) : null,
			input.createdBy,
		],
	);

	return toAdminUser(result.rows[0]);
};

const updateAdminUser = async (
	adminId: string,
	input: AdminAccountInput,
): Promise<AdminUser | null> => {
	const existingResult = await pool.query<AdminUserRow>(
		`
			SELECT
				id,
				email,
				password_hash,
				role,
				is_active,
				failed_login_attempts,
				locked_until,
				last_login_at,
				permissions,
				created_by
			FROM admin_users
			WHERE id = $1
			LIMIT 1
		`,
		[adminId],
	);
	const existing = existingResult.rows[0];
	if (!existing) {
		return null;
	}

	const permissionKeys =
		input.role === "super_admin"
			? null
			: normalizePermissionKeys(input.permissionKeys);
	const result = await pool.query<AdminUserRow>(
		`
			UPDATE admin_users
			SET
				email = $2,
				role = $3,
				is_active = $4,
				permissions = $5::jsonb,
				password_hash = CASE
					WHEN $6::text IS NULL OR LENGTH($6::text) = 0
					THEN password_hash
					ELSE $6::text
				END,
				password_changed_at = CASE
					WHEN $6::text IS NULL OR LENGTH($6::text) = 0
					THEN password_changed_at
					ELSE NOW()
				END,
				updated_at = NOW()
			WHERE id = $1
			RETURNING
				id,
				email,
				password_hash,
				role,
				is_active,
				failed_login_attempts,
				locked_until,
				last_login_at,
				permissions,
				created_by
		`,
		[
			adminId,
			normalizeEmail(input.email),
			input.role,
			input.isActive,
			permissionKeys ? JSON.stringify(permissionKeys) : null,
			input.password ? createPasswordHash(input.password) : null,
		],
	);

	return toAdminUser(result.rows[0]);
};

const deleteAdminUser = async (
	adminId: string,
): Promise<boolean> => {
	const result = await pool.query(
		"DELETE FROM admin_users WHERE id = $1",
		[adminId],
	);
	return (result.rowCount ?? 0) > 0;
};

const hasAdminPermission = (
	admin: AdminUser,
	permission: AdminPermissionKey,
): boolean => {
	if (admin.role === "super_admin") {
		return true;
	}

	return admin.permissions.includes(permission);
};

export const adminAuthService = {
	SUPPORTED_ADMIN_ROLES,
	ADMIN_PERMISSION_DEFINITIONS,
	authenticateAdmin,
	resolveAuthenticatedAdmin,
	recordAuditEvent,
	initializeAdminAuth,
	listAdminUsers,
	createAdminUser,
	updateAdminUser,
	deleteAdminUser,
	hasAdminPermission,
};

export default adminAuthService;
