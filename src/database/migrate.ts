import { readFile } from "fs/promises";
import path from "path";
import { PoolClient } from "pg";
import pool from "../config/database";
import {
	MIGRATION_LOCK_ID,
	SQL_MIGRATIONS_SUBDIRECTORY,
} from "../constants";
import logger from "../utils/logger";

type Migration = {
	id: string;
	description: string;
	file: string;
};

const SQL_MIGRATIONS_DIR = path.join(
	__dirname,
	SQL_MIGRATIONS_SUBDIRECTORY,
);

const migrations: Migration[] = [
	{
		id: "20260217_001_extensions_and_helpers",
		description:
			"Enable pgcrypto and create helper functions",
		file: "20260217_001_extensions_and_helpers.sql",
	},
	{
		id: "20260217_002_users_table",
		description:
			"Create users table and users indexes",
		file: "20260217_002_users_table.sql",
	},
	{
		id: "20260217_003_validate_users_id_type",
		description:
			"Validate users.id UUID compatibility",
		file: "20260217_003_validate_users_id_type.sql",
	},
	{
		id: "20260217_004_verification_codes",
		description:
			"Create verification codes table and indexes",
		file: "20260217_004_verification_codes.sql",
	},
	{
		id: "20260217_005_sessions",
		description:
			"Create sessions table, indexes, and trigger",
		file: "20260217_005_sessions.sql",
	},
	{
		id: "20260217_006_subscriptions",
		description:
			"Legacy billing migration (no-op)",
		file: "20260217_006_subscriptions.sql",
	},
	{
		id: "20260217_007_widgets",
		description:
			"Create widget keys and analytics tables",
		file: "20260217_007_widgets.sql",
	},
	{
		id: "20260217_008_legacy_sessions_upgrade",
		description:
			"Upgrade legacy sessions schema when required",
		file: "20260217_008_legacy_sessions_upgrade.sql",
	},
	{
		id: "20260217_009_users_backfill_defaults",
		description:
			"Backfill users pricing fields and defaults",
		file: "20260217_009_users_backfill_defaults.sql",
	},
	{
		id: "20260220_010_leads",
		description:
			"Create leads table for AI-extracted visitor contact info",
		file: "20260220_010_leads.sql",
	},
	{
		id: "20260220_011_ratings_and_followup",
		description:
			"Add follow_up_sent_at to leads and create chat_ratings table",
		file: "20260220_011_ratings_and_followup.sql",
	},
	{
		id: "20260221_012_chat_storage",
		description:
			"Create scalable chat conversations/messages storage with partitioned messages",
		file: "20260221_012_chat_storage.sql",
	},
	{
		id: "20260221_013_partition_maintenance",
		description:
			"Add partition maintenance and analytics cleanup helper functions",
		file: "20260221_013_partition_maintenance.sql",
	},
	{
		id: "20260221_014_enterprise_plan_and_limits",
		description:
			"Add enterprise plan support and normalize plan conversation limits",
		file: "20260221_014_enterprise_plan_and_limits.sql",
	},
	{
		id: "20260221_015_user_profile_completion",
		description:
			"Add login tracking and required profile completion fields",
		file: "20260221_015_user_profile_completion.sql",
	},
	{
		id: "20260221_016_feedback_suggestions",
		description:
			"Create feedback_suggestions table for dashboard feedback/suggestion submissions",
		file: "20260221_016_feedback_suggestions.sql",
	},
	{
		id: "20260223_017_enterprise_lead_webhooks",
		description:
			"Create enterprise lead webhook config/events tables for outbound CRM delivery",
		file: "20260223_017_enterprise_lead_webhooks.sql",
	},
	{
		id: "20260223_018_enterprise_unlimited_conversations",
		description:
			"Allow unlimited enterprise conversations by making conversations_limit nullable and setting enterprise to NULL",
		file: "20260223_018_enterprise_unlimited_conversations.sql",
	},
	{
		id: "20260303_019_user_onboarding",
		description:
			"Add onboarding_step, onboarding_completed, onboarding_completed_at to users table",
		file: "20260303_019_user_onboarding.sql",
	},
	{
		id: "20260304_020_admin_users",
		description:
			"Create admin users and admin audit logs tables",
		file: "20260304_020_admin_users.sql",
	},
	{
		id: "20260305_021_remove_legacy_billing",
		description:
			"Remove legacy billing tables and columns",
		file: "20260305_021_remove_legacy_billing.sql",
	},
	{
		id: "20260305_022_razorpay_billing",
		description:
			"Create Razorpay-backed plans, subscriptions, and payments tables",
		file: "20260305_022_razorpay_billing.sql",
	},
];

const ensureMigrationTable = async (
	client: PoolClient,
): Promise<void> => {
	await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(100) PRIMARY KEY,
      description TEXT NOT NULL,
      file_name TEXT NOT NULL,
      executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      duration_ms INTEGER NOT NULL
    );
  `);
};

const acquireMigrationLock = async (
	client: PoolClient,
): Promise<void> => {
	const result = await client.query<{
		pg_try_advisory_lock: boolean;
	}>(
		"SELECT pg_try_advisory_lock($1) AS pg_try_advisory_lock",
		[MIGRATION_LOCK_ID],
	);

	if (!result.rows[0]?.pg_try_advisory_lock) {
		throw new Error(
			"Another migration process is already running. Try again after it completes.",
		);
	}
};

const releaseMigrationLock = async (
	client: PoolClient,
): Promise<void> => {
	await client.query("SELECT pg_advisory_unlock($1)", [
		MIGRATION_LOCK_ID,
	]);
};

const hasMigrationRun = async (
	client: PoolClient,
	id: string,
): Promise<boolean> => {
	const result = await client.query(
		"SELECT 1 FROM schema_migrations WHERE id = $1 LIMIT 1",
		[id],
	);

	return result.rows.length > 0;
};

const recordMigration = async (
	client: PoolClient,
	migration: Migration,
	durationMs: number,
): Promise<void> => {
	await client.query(
		`INSERT INTO schema_migrations (id, description, file_name, duration_ms)
     VALUES ($1, $2, $3, $4)`,
		[
			migration.id,
			migration.description,
			migration.file,
			durationMs,
		],
	);
};

const readMigrationSql = async (
	fileName: string,
): Promise<string> => {
	const filePath = path.join(
		SQL_MIGRATIONS_DIR,
		fileName,
	);
	return readFile(filePath, "utf8");
};

const runMigrations = async (): Promise<void> => {
	const client = await pool.connect();

	try {
		await acquireMigrationLock(client);
		await ensureMigrationTable(client);

		logger.info("Starting database migrations", {
			totalMigrations: migrations.length,
		});

		for (const migration of migrations) {
			const alreadyRan = await hasMigrationRun(
				client,
				migration.id,
			);

			if (alreadyRan) {
				logger.info("Skipping migration", {
					id: migration.id,
					file: migration.file,
				});
				continue;
			}

			const sql = await readMigrationSql(
				migration.file,
			);
			const start = Date.now();

			logger.info("Running migration", {
				id: migration.id,
				description: migration.description,
				file: migration.file,
			});

			try {
				await client.query("BEGIN");
				await client.query(sql);
				await recordMigration(
					client,
					migration,
					Date.now() - start,
				);
				await client.query("COMMIT");

				logger.info(
					"Migration completed",
					{
						id: migration.id,
						durationMs:
							Date.now() - start,
					},
				);
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			}
		}

		logger.info(
			"Database migrations completed successfully",
		);
	} finally {
		await releaseMigrationLock(client).catch(
			() => {
				logger.warn(
					"Failed to release migration advisory lock",
				);
			},
		);
		client.release();
	}
};

if (require.main === module) {
	runMigrations()
		.then(() => {
			console.log(
				"Migration completed successfully",
			);
			process.exit(0);
		})
		.catch((error: Error) => {
			logger.error("Migration failed", {
				error: error.message,
				stack: error.stack,
			});
			console.error("Migration failed:", error.message);
			process.exit(1);
		});
}

export { migrations, runMigrations };
