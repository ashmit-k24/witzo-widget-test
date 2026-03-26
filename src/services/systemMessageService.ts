import pool from "../config/database";
import {
	PLATFORM_DEFAULT_SYSTEM_MESSAGE_TEMPLATE,
	SYSTEM_MESSAGE_MAX_LENGTH,
} from "../constants";
import { User } from "../types";
import { hasUserSystemMessageColumns } from "./userSystemMessageSchemaService";
import websiteBrandingService from "./websiteBrandingService";

export type SystemMessageSettings = {
	platformDefaultSystemMessage: string;
	customSystemMessage: string | null;
	useDefaultSystemMessage: boolean;
	systemMessageConfigured: boolean;
	knowledgeBoundary: string;
	effectiveSystemMessage: string;
	mode: "default" | "custom";
	updatedAt: Date | null;
};

class SystemMessageService {
	private normalizeKnowledgeBoundary(
		value: unknown,
	): "workspace_only" | "workspace_prefer" | "general_allowed" {
		const normalized = String(value || "")
			.trim()
			.toLowerCase();
		switch (normalized) {
			case "workspace_only":
			case "workspace_prefer":
			case "general_allowed":
				return normalized;
			default:
				return "workspace_only";
		}
	}

	private createHttpError(
		message: string,
		statusCode: number,
	): Error & { statusCode: number } {
		const error = new Error(message) as Error & {
			statusCode: number;
		};
		error.statusCode = statusCode;
		return error;
	}

	private renderPlatformDefaultSystemMessage(
		websiteName: string,
	): string {
		return PLATFORM_DEFAULT_SYSTEM_MESSAGE_TEMPLATE.replace(
			/\{\{websiteName\}\}/g,
			websiteName,
		);
	}

	private async mapSettings(
		user: User,
	): Promise<SystemMessageSettings> {
		const trimmedCustom = user.custom_system_message?.trim() || null;
		const useDefault =
			(user.use_default_system_message ?? true) ||
			!trimmedCustom;
		const websiteName =
			await websiteBrandingService.resolveUserWidgetLabel(
				user.id,
			);
		const platformDefaultSystemMessage =
			this.renderPlatformDefaultSystemMessage(
				websiteName,
			);

		return {
			platformDefaultSystemMessage,
			customSystemMessage: trimmedCustom,
			useDefaultSystemMessage: useDefault,
			systemMessageConfigured:
				user.system_message_configured ??
				user.onboarding_completed,
			knowledgeBoundary:
				this.normalizeKnowledgeBoundary(
					user.knowledge_boundary,
				),
			effectiveSystemMessage: useDefault
				? platformDefaultSystemMessage
				: trimmedCustom!,
			mode: useDefault ? "default" : "custom",
			updatedAt: user.updated_at ?? null,
		};
	}

	private normalizeCustomSystemMessage(
		value: unknown,
	): string {
		if (typeof value !== "string") {
			throw this.createHttpError(
				"systemMessage must be a string",
				400,
			);
		}

		const normalized = value.trim();
		if (!normalized) {
			throw this.createHttpError(
				"Custom system message cannot be empty",
				400,
			);
		}
		if (
			normalized.length > SYSTEM_MESSAGE_MAX_LENGTH
		) {
			throw this.createHttpError(
				`Custom system message must be ${SYSTEM_MESSAGE_MAX_LENGTH} characters or less`,
				400,
			);
		}

		return normalized;
	}

	private buildOnboardingUpdate(
		completeOnboarding: boolean,
	): string {
		if (!completeOnboarding) {
			return "";
		}

		return `,
      onboarding_step = GREATEST(onboarding_step, 4),
      onboarding_completed = TRUE,
      onboarding_completed_at = COALESCE(onboarding_completed_at, CURRENT_TIMESTAMP)`;
	}

	async getSettings(
		userId: string,
	): Promise<SystemMessageSettings> {
		const result = await pool.query<User>(
			"SELECT * FROM users WHERE id = $1 LIMIT 1",
			[userId],
		);

		if (result.rows.length === 0) {
			throw this.createHttpError("User not found", 404);
		}

		return this.mapSettings(result.rows[0]);
	}

	private async assertColumnsAvailable(): Promise<void> {
		if (await hasUserSystemMessageColumns()) {
			return;
		}

		throw this.createHttpError(
			"System message settings are not available until the latest database migration has been applied",
			503,
		);
	}

	async saveCustomSystemMessage(
		userId: string,
		systemMessage: unknown,
		options?: {
			completeOnboarding?: boolean;
			knowledgeBoundary?: unknown;
		},
	): Promise<SystemMessageSettings> {
		await this.assertColumnsAvailable();
		const normalized =
			this.normalizeCustomSystemMessage(
				systemMessage,
			);
		const completeOnboarding =
			options?.completeOnboarding === true;
		const knowledgeBoundary =
			this.normalizeKnowledgeBoundary(
				options?.knowledgeBoundary,
			);
		const result = await pool.query<User>(
			`UPDATE users
       SET custom_system_message = $2,
           use_default_system_message = FALSE,
           system_message_configured = TRUE,
           knowledge_boundary = $3,
           updated_at = CURRENT_TIMESTAMP
           ${this.buildOnboardingUpdate(completeOnboarding)}
       WHERE id = $1
       RETURNING *`,
			[userId, normalized, knowledgeBoundary],
		);

		if (result.rows.length === 0) {
			throw this.createHttpError("User not found", 404);
		}

		return this.mapSettings(result.rows[0]);
	}

	async useDefaultSystemMessage(
		userId: string,
		options?: {
			completeOnboarding?: boolean;
			knowledgeBoundary?: unknown;
		},
	): Promise<SystemMessageSettings> {
		await this.assertColumnsAvailable();
		const completeOnboarding =
			options?.completeOnboarding === true;
		const knowledgeBoundary =
			this.normalizeKnowledgeBoundary(
				options?.knowledgeBoundary,
			);
		const result = await pool.query<User>(
			`UPDATE users
       SET custom_system_message = NULL,
           use_default_system_message = TRUE,
           system_message_configured = TRUE,
           knowledge_boundary = $2,
           updated_at = CURRENT_TIMESTAMP
           ${this.buildOnboardingUpdate(completeOnboarding)}
       WHERE id = $1
       RETURNING *`,
			[userId, knowledgeBoundary],
		);

		if (result.rows.length === 0) {
			throw this.createHttpError("User not found", 404);
		}

		return this.mapSettings(result.rows[0]);
	}

	async completeSetup(
		userId: string,
	): Promise<SystemMessageSettings> {
		await this.assertColumnsAvailable();
		const result = await pool.query<User>(
			`UPDATE users
       SET use_default_system_message = CASE
             WHEN custom_system_message IS NULL OR btrim(custom_system_message) = ''
             THEN TRUE
             ELSE use_default_system_message
           END,
           custom_system_message = CASE
             WHEN custom_system_message IS NOT NULL AND btrim(custom_system_message) = ''
             THEN NULL
             ELSE custom_system_message
           END,
           system_message_configured = TRUE,
           onboarding_step = GREATEST(onboarding_step, 4),
           onboarding_completed = TRUE,
           onboarding_completed_at = COALESCE(onboarding_completed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
			[userId],
		);

		if (result.rows.length === 0) {
			throw this.createHttpError("User not found", 404);
		}

		return this.mapSettings(result.rows[0]);
	}

	async resolveEffectiveSystemMessage(
		userId: string,
	): Promise<string> {
		try {
			const settings = await this.getSettings(userId);
			return settings.effectiveSystemMessage;
		} catch {
			const websiteName =
				await websiteBrandingService.resolveUserWidgetLabel(
					userId,
				);
			return this.renderPlatformDefaultSystemMessage(
				websiteName,
			);
		}
	}

	async resolveKnowledgeBoundary(
		userId: string,
	): Promise<string> {
		try {
			const settings = await this.getSettings(userId);
			return settings.knowledgeBoundary;
		} catch {
			return this.normalizeKnowledgeBoundary(
				process.env.KNOWLEDGE_BOUNDARY,
			);
		}
	}
}

export default new SystemMessageService();
