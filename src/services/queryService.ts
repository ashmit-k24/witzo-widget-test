import OpenAI from "openai";
import { config } from "../config/env";
import logger from "../utils/logger";

const openai = new OpenAI({
	apiKey: config.OPENAI_API_KEY,
});

export type QueryClass =
	| "pricing"
	| "contact"
	| "case_study"
	| "service"
	| "blog"
	| "general";

export function normalizeWidgetQuery(
	q: string,
): string {
	return q
		.toLowerCase()
		.trim()
		.replace(/\s+/g, " ");
}

export function isAppointmentBookingIntent(
	q: string,
): boolean {
	return (
		/\b(book|schedule|arrange|set up|setup|plan|organize)\b[\s\w-]{0,30}\b(appointment|meeting|demo|consultation|call|callback)\b/.test(
			q,
		) ||
		/\b(appointment|meeting|demo|consultation|call|callback)\b[\s\w-]{0,20}\b(book|schedule|arrange|set up|setup)\b/.test(
			q,
		) ||
		/\b(talk to sales|speak to sales|connect with sales|connect with your team|speak with your team|sales call|book time with|schedule time with|book a slot|schedule a slot)\b/.test(
			q,
		)
	);
}

export function classifyQuery(
	query: string,
): QueryClass {
	const q = normalizeWidgetQuery(query);
	if (
		/\b(price|pricing|cost|plan|package|subscription|charge|fee|fees)\b/.test(
			q,
		)
	) {
		return "pricing";
	}
	if (
		/\b(contact|email|phone|call|address|location|reach|support)\b/.test(
			q,
		)
	) {
		return "contact";
	}
	if (
		/\b(case study|portfolio|client|project|work|success story|testimonial)\b/.test(
			q,
		)
	) {
		return "case_study";
	}
	if (
		/\b(service|services|offer|provide|solution|solutions|development|design|marketing|seo)\b/.test(
			q,
		)
	) {
		return "service";
	}
	if (
		/\b(blog|article|news|insight|guide)\b/.test(
			q,
		)
	) {
		return "blog";
	}
	return "general";
}

export function getTopKForQuery(
	query: string,
): number {
	switch (classifyQuery(query)) {
		case "pricing":
		case "contact":
			return 8;
		case "case_study":
		case "service":
			return 18;
		case "blog":
			return 12;
		case "general":
			return 15;
	}
}

export function buildPageTypeFilters(
	query: string,
): string[] {
	switch (classifyQuery(query)) {
		case "pricing":
			return ["pricing"];
		case "contact":
			return ["contact"];
		case "case_study":
			return ["case_study", "portfolio"];
		case "service":
			return ["service", "services", "home"];
		case "blog":
			return ["blog"];
		case "general":
			return [];
	}
}

export function generateQueryVariations(
	query: string,
): string[] {
	const q = query.trim();
	if (!q) return [];
	const normalized = normalizeWidgetQuery(q);
	const variations = new Set<string>();

	if (
		/\b(price|pricing|cost)\b/.test(normalized)
	) {
		variations.add(`${q} pricing plans cost`);
	}
	if (
		/\b(service|services|offer|provide)\b/.test(
			normalized,
		)
	) {
		variations.add(`${q} services solutions`);
	}
	if (
		/\b(project|portfolio|case study|client)\b/.test(
			normalized,
		)
	) {
		variations.add(
			`${q} portfolio case studies clients`,
		);
	}
	if (
		/\b(contact|email|phone|address)\b/.test(
			normalized,
		)
	) {
		variations.add(`${q} contact details`);
	}

	return Array.from(variations)
		.filter(
			(item) =>
				normalizeWidgetQuery(item) !== normalized,
		)
		.slice(0, 3);
}

export async function stepBackRewrite(
	query: string,
	history?: Array<{
		role: string;
		content: string;
	}>,
): Promise<string> {
	const trimmed = query.trim();
	if (!trimmed) return trimmed;

	const words = trimmed.split(/\s+/);
	const contextDependent =
		/\b(it|this|that|they|them|those|there|same|above|previous)\b/i.test(
			trimmed,
		);
	if (words.length > 12 && !contextDependent) {
		return trimmed;
	}
	if (!config.OPENAI_API_KEY?.trim()) {
		return trimmed;
	}

	try {
		const recentHistory = (history ?? [])
			.slice(-6)
			.map(
				(message) =>
					`${message.role}: ${message.content}`,
			)
			.join("\n");
		const completion =
			await openai.chat.completions.create({
				model: "gpt-4o-mini",
				messages: [
					{
						role: "system",
						content:
							"Rewrite the user query into one standalone website knowledge-base search query. Return only the rewritten query.",
					},
					{
						role: "user",
						content: recentHistory
							? `Conversation:\n${recentHistory}\n\nQuery: ${trimmed}`
							: `Query: ${trimmed}`,
					},
				],
				temperature: 0,
				max_tokens: 80,
			});
		const rewritten =
			completion.choices[0]?.message?.content?.trim() ||
			trimmed;
		return rewritten.length > 0 &&
			rewritten.length < 300
			? rewritten.replace(/^["']|["']$/g, "")
			: trimmed;
	} catch (error) {
		logger.warn(
			"RAG step-back rewrite failed; using original query",
			{
				error:
					error instanceof Error
						? error.message
						: String(error),
			},
		);
		return trimmed;
	}
}
