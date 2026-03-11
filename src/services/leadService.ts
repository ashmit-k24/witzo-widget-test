import OpenAI from "openai";
import {
	getPlanCapabilities,
	PlanType,
} from "../config/planConfig";
import pool from "../config/database";
import { config } from "../config/env";
import { ChatMessage } from "../types";
import logger from "../utils/logger";
import emailService from "./emailService";
import { leadWebhookService } from "./leadWebhookService";

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
	follow_up_sent_at: Date | null;
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
	private normalizeOptionalValue(
		value: string | null | undefined,
	): string | null {
		if (typeof value !== "string") {
			return null;
		}
		const normalized = value.trim();
		return normalized.length > 0 ? normalized : null;
	}

	private hasConnectableChannel(
		extracted: ExtractedContact,
	): boolean {
		const email = this.normalizeOptionalValue(
			extracted.email,
		);
		const phone = this.normalizeOptionalValue(
			extracted.phone,
		);

		return Boolean(email || phone);
	}

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
		planType?: PlanType,
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

			// Only persist leads when there is a direct contact method.
			// Name, company, or summary alone should not create a lead.
			if (!this.hasConnectableChannel(extracted)) {
				logger.info(
					"Skipping lead upsert: no email or phone found",
					{
						userId,
						sessionId,
					},
				);
				return;
			}

			const leadResult = await pool.query<{
				id: string;
				status: "new" | "contacted" | "qualified" | "converted";
			}>(
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
					updated_at    = CURRENT_TIMESTAMP
				 RETURNING id, status`,
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
			const leadId = leadResult.rows[0]?.id;
			if (leadId) {
				void leadWebhookService
					.queueLeadEvent(
						userId,
						"lead.upserted",
						{
							leadId,
							sessionId,
							widgetKeyId,
							status:
								leadResult.rows[0]?.status ?? "new",
							contact: extracted,
							metadata: {
								ipAddress:
									metadata?.ipAddress ?? null,
								sourceUrl:
									metadata?.sourceUrl ?? null,
							},
							messageCount: messages.length,
						},
						leadId,
					)
					.catch((error) => {
						logger.error(
							"Failed to queue webhook for upserted lead",
							{
								error,
								userId,
								sessionId,
							},
						);
					});
			}

			// Auto follow-up email — basic plan only, once per lead
			const capabilities = getPlanCapabilities(
				planType || "free",
			);
			if (
				capabilities.autoFollowUpEmail &&
				extracted.email
			) {
				try {
					const checkResult = await pool.query(
						`SELECT follow_up_sent_at, name FROM leads
						 WHERE user_id = $1 AND session_id = $2`,
						[userId, sessionId],
					);
					const leadRow = checkResult.rows[0];
					if (leadRow && leadRow.follow_up_sent_at === null) {
						const ownerResult = await pool.query(
							`SELECT email FROM users WHERE id = $1`,
							[userId],
						);
						const ownerEmail: string | null =
							ownerResult.rows[0]?.email ?? null;

						await emailService.sendFollowUpEmail(
							extracted.email,
							extracted.name ?? null,
							ownerEmail,
						);

						await pool.query(
							`UPDATE leads SET follow_up_sent_at = NOW()
							 WHERE user_id = $1 AND session_id = $2`,
							[userId, sessionId],
						);

						logger.info("Follow-up email sent for lead", {
							userId,
							sessionId,
						});
					}
				} catch (emailErr) {
					logger.error(
						"Failed to send follow-up email for lead",
						{ userId, sessionId, error: emailErr },
					);
				}
			}
		} catch (error) {
			logger.error("Error upserting lead", {
				error,
				userId,
				sessionId,
			});
		}
	}

	async saveContactFormLead(
		userId: string,
		sessionId: string,
		widgetKeyId: number,
		data: {
			name?: string | null;
			email: string;
			summary?: string | null;
			ipAddress?: string;
			sourceUrl?: string;
		},
	): Promise<void> {
		const result = await pool.query<{
			id: string;
			status: "new" | "contacted" | "qualified" | "converted";
		}>(
			`INSERT INTO leads
				(user_id, widget_key_id, session_id, name, email, chat_summary,
				 raw_contact, ip_address, source_url, message_count, status)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'new')
			 ON CONFLICT (user_id, session_id) DO UPDATE SET
				name         = COALESCE(EXCLUDED.name, leads.name),
				email        = COALESCE(EXCLUDED.email, leads.email),
				chat_summary = COALESCE(EXCLUDED.chat_summary, leads.chat_summary),
				raw_contact  = EXCLUDED.raw_contact,
				updated_at   = CURRENT_TIMESTAMP
			 RETURNING id, status`,
			[
				userId,
				widgetKeyId,
				sessionId,
				data.name ?? null,
				data.email,
				data.summary ?? null,
				JSON.stringify({
					name: data.name,
					email: data.email,
					message: data.summary,
				}),
				data.ipAddress ?? null,
				data.sourceUrl ?? null,
			],
		);
		logger.info("Contact form lead saved", { userId, sessionId });
		const leadId = result.rows[0]?.id;
		if (leadId) {
			void leadWebhookService
				.queueLeadEvent(
					userId,
					"lead.contact_form",
					{
						leadId,
						sessionId,
						widgetKeyId,
						status:
							result.rows[0]?.status ?? "new",
						contact: {
							name: data.name ?? null,
							email: data.email,
							summary: data.summary ?? null,
						},
						metadata: {
							ipAddress:
								data.ipAddress ?? null,
							sourceUrl:
								data.sourceUrl ?? null,
						},
					},
					leadId,
				)
				.catch((error) => {
					logger.error(
						"Failed to queue webhook for contact-form lead",
						{
							error,
							userId,
							sessionId,
						},
					);
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
					`SELECT
             id,
             name,
             email,
             phone,
             country,
             company,
             chat_summary,
             status,
             message_count,
             created_at
           FROM leads WHERE ${where}
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
			`SELECT
         id,
         name,
         email,
         phone,
         country,
         company,
         chat_summary,
         status,
         message_count,
         created_at
       FROM leads
       WHERE id = $1 AND user_id = $2`,
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
			 RETURNING
         id,
         name,
         email,
         phone,
         country,
         company,
         chat_summary,
         status,
         message_count,
         created_at`,
			[status, leadId, userId],
		);
		const updatedLead = result.rows[0] || null;
		if (updatedLead) {
			void leadWebhookService
				.queueLeadEvent(
					userId,
					"lead.status_updated",
					{
						leadId: updatedLead.id,
						status: updatedLead.status,
						name: updatedLead.name,
						email: updatedLead.email,
						company: updatedLead.company,
						updatedAt: new Date().toISOString(),
					},
					updatedLead.id,
				)
				.catch((error) => {
					logger.error(
						"Failed to queue webhook for lead status update",
						{ error, userId, leadId },
					);
				});
		}
		return updatedLead;
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
