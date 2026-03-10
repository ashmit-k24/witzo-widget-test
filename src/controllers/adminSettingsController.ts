import { NextFunction, Request, Response } from "express";
import pool from "../config/database";
import adminAuthService from "../services/adminAuthService";
import { domainPolicyService } from "../services/domainPolicyService";

const normalizeList = (values: unknown): {
	domains: string[];
	invalid: string[];
} => {
	if (!Array.isArray(values)) {
		return { domains: [], invalid: ["Domains must be an array"] };
	}

	const invalid: string[] = [];
	const domains: string[] = [];

	for (const entry of values) {
		if (typeof entry !== "string") {
			invalid.push(String(entry));
			continue;
		}
		const normalized = domainPolicyService.normalizeDomain(entry);
		if (!normalized) {
			invalid.push(entry);
			continue;
		}
		domains.push(normalized);
	}

	return {
		domains: Array.from(new Set(domains)).sort(),
		invalid,
	};
};

export const listDisallowedDomains = async (
	_req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const result = await pool.query<{ domain: string }>(
			`SELECT domain FROM disallowed_domains ORDER BY domain ASC`,
		);
		res.json({
			data: {
				domains: result.rows.map((row) => row.domain),
			},
		});
	} catch (error) {
		next(error);
	}
};

export const updateDisallowedDomains = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { domains } = req.body as {
			domains?: unknown;
		};

		const normalized = normalizeList(domains);
		if (normalized.invalid.length > 0) {
			res.status(400).json({
				message: "Invalid domain entries",
				errors: normalized.invalid,
			});
			return;
		}

		const client = await pool.connect();
		try {
			await client.query("BEGIN");

			if (normalized.domains.length === 0) {
				await client.query(`DELETE FROM disallowed_domains`);
			} else {
				await client.query(
					`DELETE FROM disallowed_domains
					 WHERE domain <> ALL($1::text[])`,
					[normalized.domains],
				);
				await client.query(
					`INSERT INTO disallowed_domains (domain, created_by)
					 SELECT UNNEST($1::text[]), $2::uuid
					 ON CONFLICT (domain)
					 DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
					[normalized.domains, req.admin?.id ?? null],
				);
			}

			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}

		domainPolicyService.invalidateCache();

		await adminAuthService.recordAuditEvent({
			adminUserId: req.admin?.id,
			action: "admin.settings.update_disallowed_domains",
			ipAddress: req.ip,
			userAgent: req.get("user-agent") ?? null,
			metadata: { domains: normalized.domains },
		});

		res.json({
			data: {
				domains: normalized.domains,
			},
		});
	} catch (error) {
		next(error);
	}
};
