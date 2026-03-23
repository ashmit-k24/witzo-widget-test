import pool from "../config/database";

const REQUIRED_COLUMNS = [
	"custom_system_message",
	"use_default_system_message",
	"system_message_configured",
	"knowledge_boundary",
] as const;

const CACHE_TTL_MS = 60_000;

let cachedValue: boolean | null = null;
let cachedAt = 0;

async function querySchemaAvailability(): Promise<boolean> {
	const result = await pool.query<{
		column_name: string;
	}>(
		`SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'users'
       AND column_name = ANY($1::text[])`,
		[REQUIRED_COLUMNS],
	);

	return result.rows.length === REQUIRED_COLUMNS.length;
}

export async function hasUserSystemMessageColumns(): Promise<boolean> {
	if (
		cachedValue !== null &&
		Date.now() - cachedAt < CACHE_TTL_MS
	) {
		return cachedValue;
	}

	const available = await querySchemaAvailability();
	cachedValue = available;
	cachedAt = Date.now();
	return available;
}

export async function getUserSystemMessageSelectFields(
	alias: string,
): Promise<string> {
	if (await hasUserSystemMessageColumns()) {
		return `, ${alias}.use_default_system_message, ${alias}.system_message_configured, ${alias}.knowledge_boundary`;
	}

	return `, TRUE AS use_default_system_message, ${alias}.onboarding_completed AS system_message_configured, 'workspace_only'::text AS knowledge_boundary`;
}
