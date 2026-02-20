import OpenAI from "openai";
import pool from "../config/database";
import { config } from "../config/env";
import { ChatMessage } from "../types";
import logger from "../utils/logger";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export interface Lead {
	id: string;
	user_id: string;
	widget_key_id: number | null;
	session_id: string;
	name: string | null;
	email: string | null;
	phone: string | null;
	country: string | null;
	company: string | null;
	chat_summary: string | null;
	raw_contact: Record<string, any>;
	status: "new" | "contacted" | "qualified" | "converted";
	source_url: string | null;
	ip_address: string | null;
	message_count: number;
	created_at: Date;
	updated_at: Date;
}

export interface ExtractedContact {
	name: string | null;
	email: string | null;
	phone: string | null;
	country: string | null;
	company: string | null;
	summary: string | null;
}

export interface LeadListOptions {
	page?: number;
	limit?: number;
	status?: string;
	search?: string;
}

class LeadService {
	private async extractContactFromMessages(
		messages: ChatMessage[],
	): Promise<ExtractedContact> {
		const conversation = messages
			.filter((m) => m.role !== "system")
			.map(
				(m) =>
					`${m.role === "user" ? "Visitor" : "Assistant"}: ${m.content}`,
			)
			.join("\n");

		const prompt = `You are a data extraction assistant. Analyze the following chat conversation and extract any contact information the visitor may have mentioned. Also write a brief summary of what the visitor was asking about or interested in.

Return ONLY a valid JSON object with these exact keys (use null for any field not found):
{
  "name": "full name if mentioned",
  "email": "email address if mentioned",
  "phone": "phone number if mentioned",
  "country": "country if mentioned",
  "company": "company or organization if mentioned",
  "summary": "2-3 sentence summary of the visitor's main intent or inquiry"
}

Chat conversation:
${conversation}`;

		try {
			const completion =
				await openai.chat.completions.create({
					model: "gpt-4o",
					messages: [
						{ role: "user", content: prompt },
					],
					temperature: 0,
					max_tokens: 300,
					response_format: { type: "json_object" },
				});

			const raw =
				completion.choices[0].message.content ||
				"{}";
			const parsed = JSON.parse(raw);

			return {
				name: parsed.name || null,
				email: parsed.email || null,
				phone: parsed.phone || null,
				country: parsed.country || null,
				company: parsed.company || null,
				summary: parsed.summary || null,
			};
		} catch (err) {
			logger.error(
				"Lead extraction OpenAI error",
				{ err },
			);
			return {
				name: null,
				email: null,
				phone: null,
				country: null,
				company: null,
				summary: null,
			};
		}
	}

	async extractAndUpsertLead(
		userId: string,
		sessionId: string,
		widgetKeyId: number,
		messages: ChatMessage[],
		metadata?: {
			ipAddress?: string;
			sourceUrl?: string;
		},
	): Promise<void> {
		try {
			const userMessages = messages.filter(
				(m) => m.role === "user",
			);
			if (userMessages.length < 1) return;

			const extracted =
				await this.extractContactFromMessages(
					messages,
				);

			const hasAnyContact =
				extracted.name ||
				extracted.email ||
				extracted.phone ||
				extracted.country ||
				extracted.company ||
				extracted.summary;

			if (!hasAnyContact) return;

			await pool.query(
				`INSERT INTO leads
					(user_id, widget_key_id, session_id, name, email, phone, country, company,
					 chat_summary, raw_contact, ip_address, source_url, message_count)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
				 ON CONFLICT (user_id, session_id) DO UPDATE SET
					name          = COALESCE(EXCLUDED.name, leads.name),
					email         = COALESCE(EXCLUDED.email, leads.email),
					phone         = COALESCE(EXCLUDED.phone, leads.phone),
					country       = COALESCE(EXCLUDED.country, leads.country),
					company       = COALESCE(EXCLUDED.company, leads.company),
					chat_summary  = EXCLUDED.chat_summary,
					raw_contact   = EXCLUDED.raw_contact,
					message_count = EXCLUDED.message_count,
					updated_at    = CURRENT_TIMESTAMP`,
				[
					userId,
					widgetKeyId,
					sessionId,
					extracted.name,
					extracted.email,
					extracted.phone,
					extracted.country,
					extracted.company,
					extracted.summary,
					JSON.stringify(extracted),
					metadata?.ipAddress || null,
					metadata?.sourceUrl || null,
					messages.length,
				],
			);

			logger.info("Lead upserted", {
				userId,
				sessionId,
			});
		} catch (error) {
			logger.error("Error upserting lead", {
				error,
				userId,
				sessionId,
			});
		}
	}

	async getLeads(
		userId: string,
		options: LeadListOptions = {},
	): Promise<{ leads: Lead[]; total: number }> {
		const {
			page = 1,
			limit = 20,
			status,
			search,
		} = options;
		const offset = (page - 1) * limit;

		const conditions: string[] = [
			"user_id = $1",
		];
		const values: any[] = [userId];
		let idx = 2;

		if (status && status !== "all") {
			conditions.push(`status = $${idx++}`);
			values.push(status);
		}

		if (search) {
			conditions.push(
				`(name ILIKE $${idx} OR email ILIKE $${idx} OR company ILIKE $${idx})`,
			);
			values.push(`%${search}%`);
			idx++;
		}

		const where = conditions.join(" AND ");

		const [dataResult, countResult] =
			await Promise.all([
				pool.query(
					`SELECT * FROM leads WHERE ${where}
					 ORDER BY created_at DESC
					 LIMIT $${idx} OFFSET $${idx + 1}`,
					[...values, limit, offset],
				),
				pool.query(
					`SELECT COUNT(*) FROM leads WHERE ${where}`,
					values,
				),
			]);

		return {
			leads: dataResult.rows as Lead[],
			total: parseInt(countResult.rows[0].count),
		};
	}

	async getLead(
		userId: string,
		leadId: string,
	): Promise<Lead | null> {
		const result = await pool.query(
			`SELECT * FROM leads WHERE id = $1 AND user_id = $2`,
			[leadId, userId],
		);
		return result.rows[0] || null;
	}

	async updateLeadStatus(
		userId: string,
		leadId: string,
		status: string,
	): Promise<Lead | null> {
		const validStatuses = [
			"new",
			"contacted",
			"qualified",
			"converted",
		];
		if (!validStatuses.includes(status)) {
			throw new Error("Invalid status value");
		}

		const result = await pool.query(
			`UPDATE leads SET status = $1, updated_at = CURRENT_TIMESTAMP
			 WHERE id = $2 AND user_id = $3
			 RETURNING *`,
			[status, leadId, userId],
		);
		return result.rows[0] || null;
	}

	async deleteLead(
		userId: string,
		leadId: string,
	): Promise<boolean> {
		const result = await pool.query(
			`DELETE FROM leads WHERE id = $1 AND user_id = $2`,
			[leadId, userId],
		);
		return (result.rowCount ?? 0) > 0;
	}
}

export const leadService = new LeadService();
