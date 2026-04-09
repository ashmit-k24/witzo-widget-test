import OpenAI from "openai";
import pool from "../config/database";
import { config } from "../config/env";
import { redisCache } from "../config/redis";
import logger from "../utils/logger";
import widgetService from "./widgetService";

export type WidgetPersonaKey =
	| "sales"
	| "customer_support"
	| "ecommerce"
	| "website_information"
	| "general_information";

export type WidgetPersona = {
	key: WidgetPersonaKey;
	label: string;
	description: string;
	systemPrompt: string;
	isActive: boolean;
	updatedAt: Date | null;
};

const PERSONA_ORDER: WidgetPersonaKey[] = [
	"sales",
	"customer_support",
	"ecommerce",
	"website_information",
	"general_information",
];

const DEFAULT_PERSONAS: Record<
	WidgetPersonaKey,
	Omit<WidgetPersona, "key" | "updatedAt">
> = {
	sales: {
		label: "Sales",
		description:
			"Qualify interest, explain value, and guide visitors toward the next step.",
		systemPrompt:
			"Persona: Sales assistant. Help visitors understand offers, qualify interest naturally, answer objections with facts from the knowledge base, and guide them toward a demo, consultation, quote, purchase, or contact step when appropriate. Keep the tone helpful, not pushy.",
		isActive: true,
	},
	customer_support: {
		label: "Customer Support",
		description:
			"Resolve questions, troubleshoot issues, and collect details when escalation is needed.",
		systemPrompt:
			"Persona: Customer support assistant. Focus on solving the visitor's issue clearly and calmly. Ask concise follow-up questions when needed, use the knowledge base as the source of truth, and offer escalation or contact steps when the answer is not available.",
		isActive: true,
	},
	ecommerce: {
		label: "Ecommerce",
		description:
			"Help shoppers compare products, understand policies, and move toward purchase.",
		systemPrompt:
			"Persona: Ecommerce shopping assistant. Help visitors find suitable products or services, compare options, explain shipping, returns, pricing, and availability only when supported by the knowledge base, and guide them toward checkout or inquiry steps without inventing details.",
		isActive: true,
	},
	website_information: {
		label: "Website Information",
		description:
			"Answer questions about website pages, services, policies, and company details.",
		systemPrompt:
			"Persona: Website information assistant. Help visitors quickly find and understand information from the website, including services, pages, policies, company details, and contact paths. Stay tightly grounded in the knowledge base.",
		isActive: true,
	},
	general_information: {
		label: "General Information",
		description:
			"Provide broad, friendly help while still preferring website knowledge.",
		systemPrompt:
			"Persona: General information assistant. Answer in a friendly, useful way, prioritizing the website knowledge base for business-specific facts. If a general question is outside the knowledge base, be clear about what is known and avoid unsupported claims.",
		isActive: true,
	},
};

function normalizePersonaKey(value: unknown): WidgetPersonaKey {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return (PERSONA_ORDER as string[]).includes(normalized)
		? (normalized as WidgetPersonaKey)
		: "general_information";
}

function mapRow(row: any): WidgetPersona {
	return {
		key: normalizePersonaKey(row.persona_key),
		label: row.label,
		description: row.description,
		systemPrompt: row.system_prompt,
		isActive: row.is_active !== false,
		updatedAt: row.updated_at ?? null,
	};
}

class PersonaService {
	private openai = new OpenAI({
		apiKey: config.OPENAI_API_KEY,
	});

	private async ensureDefaultPersonas(): Promise<void> {
		for (const key of PERSONA_ORDER) {
			const persona = DEFAULT_PERSONAS[key];
			await pool.query(
				`INSERT INTO widget_personas (persona_key, label, description, system_prompt, is_active)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (persona_key) DO NOTHING`,
				[
					key,
					persona.label,
					persona.description,
					persona.systemPrompt,
					persona.isActive,
				],
			);
		}
	}

	async listPersonas(includeInactive = false): Promise<WidgetPersona[]> {
		try {
			await this.ensureDefaultPersonas();
			const result = await pool.query(
				`SELECT persona_key, label, description, system_prompt, is_active, updated_at
				 FROM widget_personas
				 WHERE ($1::boolean = TRUE OR is_active = TRUE)`,
				[includeInactive],
			);
			const orderIndex = new Map(
				PERSONA_ORDER.map((key, index) => [
					key,
					index,
				]),
			);
			return result.rows
				.map(mapRow)
				.sort(
					(a, b) =>
						(orderIndex.get(a.key) ?? 99) -
						(orderIndex.get(b.key) ?? 99),
				);
		} catch (error) {
			logger.warn("persona: failed to list personas; using defaults", { error });
			return PERSONA_ORDER.map((key) => ({
				key,
				...DEFAULT_PERSONAS[key],
				updatedAt: null,
			})).filter((persona) => includeInactive || persona.isActive);
		}
	}

	async updatePersona(
		key: unknown,
		input: {
			label?: unknown;
			description?: unknown;
			systemPrompt?: unknown;
			isActive?: unknown;
		},
	): Promise<WidgetPersona> {
		await this.ensureDefaultPersonas();
		const personaKey = normalizePersonaKey(key);
		const current = DEFAULT_PERSONAS[personaKey];
		const label =
			typeof input.label === "string" && input.label.trim()
				? input.label.trim()
				: current.label;
		const description =
			typeof input.description === "string"
				? input.description.trim()
				: current.description;
		const systemPrompt =
			typeof input.systemPrompt === "string" &&
			input.systemPrompt.trim()
				? input.systemPrompt.trim()
				: current.systemPrompt;
		const isActive =
			typeof input.isActive === "boolean"
				? input.isActive
				: current.isActive;

		const result = await pool.query(
			`INSERT INTO widget_personas (persona_key, label, description, system_prompt, is_active)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (persona_key) DO UPDATE SET
				label = EXCLUDED.label,
				description = EXCLUDED.description,
				system_prompt = EXCLUDED.system_prompt,
				is_active = EXCLUDED.is_active,
				updated_at = CURRENT_TIMESTAMP
			 RETURNING persona_key, label, description, system_prompt, is_active, updated_at`,
			[
				personaKey,
				label,
				description,
				systemPrompt,
				isActive,
			],
		);
		await this.clearAllSemanticAnswerCaches();
		return mapRow(result.rows[0]);
	}

	async getPersonaPrompt(key: unknown): Promise<string> {
		const personaKey = normalizePersonaKey(key);
		try {
			await this.ensureDefaultPersonas();
			const result = await pool.query(
				`SELECT system_prompt, is_active
				 FROM widget_personas
				 WHERE persona_key = $1
				 LIMIT 1`,
				[personaKey],
			);
			const row = result.rows[0];
			if (row?.is_active !== false && row?.system_prompt) {
				return row.system_prompt;
			}
			if (row?.is_active === false) {
				return this.getDefaultActivePrompt();
			}
		} catch (error) {
			logger.warn("persona: failed to load prompt; using default", {
				error,
				personaKey,
			});
		}
		return DEFAULT_PERSONAS[personaKey].systemPrompt;
	}

	async getUserPersonaKey(userId: string): Promise<WidgetPersonaKey> {
		const widget = await widgetService.getUserWidgetKey(userId);
		return normalizePersonaKey(widget?.widget_config?.personaKey);
	}

	async getUserPersonaPrompt(userId: string): Promise<string> {
		const personaKey = await this.getUserPersonaKey(userId);
		return this.getPersonaPrompt(personaKey);
	}

	async setUserPersona(
		userId: string,
		personaKey: unknown,
		options?: {
			manualOverride?: boolean;
			autoDetected?: boolean;
		},
	): Promise<void> {
		const widget = await widgetService.getUserWidgetKey(userId);
		if (!widget) return;
		const normalizedPersonaKey = normalizePersonaKey(personaKey);
		const nextConfig: Record<string, any> = {
			...(widget.widget_config || {}),
			personaKey: normalizedPersonaKey,
			personaAutoDetected: options?.autoDetected === true,
			personaManualOverride: options?.manualOverride === true,
			personaUpdatedAt: new Date().toISOString(),
		};
		if (options?.autoDetected) {
			nextConfig.personaAutoDetectedAt =
				new Date().toISOString();
		}
		await widgetService.updateWidgetKey(userId, {
			widgetConfig: nextConfig,
		});
		await redisCache.del(`chat:semantic-answer:${userId}`);
	}

	private async getDefaultActivePrompt(): Promise<string> {
		try {
			const result = await pool.query(
				`SELECT system_prompt
				 FROM widget_personas
				 WHERE persona_key = 'general_information' AND is_active = TRUE
				 LIMIT 1`,
			);
			if (result.rows[0]?.system_prompt) {
				return result.rows[0].system_prompt;
			}
		} catch (error) {
			logger.warn("persona: failed to load default active prompt", {
				error,
			});
		}
		return DEFAULT_PERSONAS.general_information.systemPrompt;
	}

	private async clearAllSemanticAnswerCaches(): Promise<void> {
		try {
			let cursor = "0";
			do {
				const [nextCursor, keys] =
					await redisCache.scan(
						cursor,
						"MATCH",
						"chat:semantic-answer:*",
						"COUNT",
						100,
					);
				cursor = nextCursor;
				if (keys.length > 0) {
					await redisCache.del(...keys);
				}
			} while (cursor !== "0");
		} catch (error) {
			logger.warn(
				"persona: failed to clear semantic answer caches",
				{ error },
			);
		}
	}

	async autoDetectAndApplyPersona(
		userId: string,
		pages: Array<{
			url: string;
			title?: string;
			content?: string;
		}>,
	): Promise<WidgetPersonaKey | null> {
		const widget = await widgetService.getUserWidgetKey(userId);
		if (!widget || widget.widget_config?.personaManualOverride === true) {
			return null;
		}
		const detected = await this.detectPersona(pages);
		await this.setUserPersona(userId, detected, {
			autoDetected: true,
			manualOverride: false,
		});
		logger.info("persona: auto-detected widget persona", {
			userId,
			personaKey: detected,
			pages: pages.length,
		});
		return detected;
	}

	private async detectPersona(
		pages: Array<{
			url: string;
			title?: string;
			content?: string;
		}>,
	): Promise<WidgetPersonaKey> {
		const sample = pages
			.slice(0, 25)
			.map((page) =>
				[
					`URL: ${page.url}`,
					page.title ? `Title: ${page.title}` : "",
					(page.content || "").slice(0, 800),
				]
					.filter(Boolean)
					.join("\n"),
			)
			.join("\n\n---\n\n")
			.slice(0, 12000);
		if (!sample.trim()) return "general_information";

		try {
			const completion =
				await this.openai.chat.completions.create({
					model: "gpt-4o-mini",
					temperature: 0,
					max_tokens: 20,
					messages: [
						{
							role: "system",
							content:
								"Classify the website into exactly one persona key: sales, customer_support, ecommerce, website_information, general_information. Return only the key.",
						},
						{ role: "user", content: sample },
					],
				});
			return normalizePersonaKey(
				completion.choices[0]?.message?.content,
			);
		} catch (error) {
			logger.warn("persona: AI detection failed; using heuristic", { error });
			return this.detectPersonaHeuristic(sample);
		}
	}

	private detectPersonaHeuristic(sample: string): WidgetPersonaKey {
		const text = sample.toLowerCase();
		const score = (terms: string[]) =>
			terms.reduce(
				(total, term) =>
					total +
					(text.includes(term.toLowerCase()) ? 1 : 0),
				0,
			);
		const scores: Record<WidgetPersonaKey, number> = {
			ecommerce: score([
				"cart",
				"checkout",
				"shop",
				"product",
				"shipping",
				"return policy",
				"add to cart",
			]),
			customer_support: score([
				"support",
				"help center",
				"troubleshoot",
				"ticket",
				"faq",
				"refund",
			]),
			sales: score([
				"book a demo",
				"pricing",
				"quote",
				"consultation",
				"sales",
				"request a demo",
			]),
			website_information: score([
				"about us",
				"services",
				"portfolio",
				"case study",
				"contact us",
			]),
			general_information: 0,
		};
		const [key] = Object.entries(scores).sort(
			(a, b) => b[1] - a[1],
		)[0] as [WidgetPersonaKey, number];
		return scores[key] > 0 ? key : "general_information";
	}
}

export const personaService = new PersonaService();
export default personaService;
