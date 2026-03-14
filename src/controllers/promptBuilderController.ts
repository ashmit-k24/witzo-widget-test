import { Request, Response } from "express";
import OpenAI from "openai";
import { config } from "../config/env";
import { CHAT_COMPLETION_MODEL } from "../constants";
import logger from "../utils/logger";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

type Tone = "professional" | "friendly" | "formal" | "casual" | "happy";

interface PromptConfig {
	tone: Tone;
	businessContext?: string;
	leadCapture: { email: boolean; name: boolean; phone: boolean };
	behavior: {
		askClarifying: boolean;
		keepConcise: boolean;
		detailedExplanations: boolean;
		stayOnTopic: boolean;
	};
}

const TONE_DESCRIPTIONS: Record<Tone, string> = {
	professional: "polished, authoritative, and business-ready — like an expert consultant",
	friendly: "warm, approachable, and conversational — like a helpful team member",
	formal: "structured, precise, and reserved — like a formal corporate representative",
	casual: "relaxed, natural, and informal — like a knowledgeable friend",
	happy: "upbeat, enthusiastic, and positive — energetic and encouraging",
};

function buildMetaPrompt(config: PromptConfig): string {
	const toneDesc = TONE_DESCRIPTIONS[config.tone];

	const leadFields = [
		config.leadCapture.name && "visitor's full name",
		config.leadCapture.email && "visitor's email address",
		config.leadCapture.phone && "visitor's phone number",
	].filter(Boolean) as string[];

	const behaviors: string[] = [];
	if (config.behavior.askClarifying) behaviors.push("ask clarifying questions when intent is ambiguous");
	if (config.behavior.keepConcise) behaviors.push("keep all responses concise and to the point");
	if (config.behavior.detailedExplanations) behaviors.push("provide thorough, detailed explanations for complex topics");
	if (config.behavior.stayOnTopic) behaviors.push("stay strictly on-topic and politely redirect off-topic questions");

	return `You are an expert AI prompt engineer specializing in business chatbot system prompts.

Generate a high-quality, production-ready system prompt for a business website chatbot with these exact specifications:

**Tone**: ${config.tone} — ${toneDesc}
${config.businessContext?.trim() ? `**Business Context**: ${config.businessContext.trim()}` : "**Business**: A general business (the prompt should work for any industry)"}
**Conversation behaviors required**:
${behaviors.length > 0 ? behaviors.map((b) => `- ${b}`).join("\n") : "- Be helpful and accurate"}
${
	leadFields.length > 0
		? `**Lead capture**: Naturally collect ${leadFields.join(", ")} from visitors during or at the end of conversations`
		: "**Lead capture**: Not required"
}

Requirements for the generated system prompt:
- Write in second-person ("You are...", "Your role is...")
- Be specific and actionable — no vague platitudes
- Include clear rules for edge cases (what to do when you don't know something, how to handle complaints, etc.)
- Structure it with logical sections if needed
- The prompt should be 200–350 words — thorough but not bloated
- Do NOT include meta-commentary or explanations — output ONLY the system prompt itself
- Do NOT use markdown headers in the output — use plain structured paragraphs

Output only the system prompt text, nothing else.`;
}

export const generatePrompt = async (req: Request, res: Response): Promise<void> => {
	try {
		const { config: promptConfig } = req.body as { config: PromptConfig };

		if (!promptConfig || !promptConfig.tone) {
			res.status(400).json({ success: false, message: "Invalid configuration: tone is required" });
			return;
		}

		const validTones: Tone[] = ["professional", "friendly", "formal", "casual", "happy"];
		if (!validTones.includes(promptConfig.tone)) {
			res.status(400).json({ success: false, message: "Invalid tone value" });
			return;
		}

		const metaPrompt = buildMetaPrompt(promptConfig);

		const completion = await openai.chat.completions.create({
			model: CHAT_COMPLETION_MODEL,
			messages: [{ role: "user", content: metaPrompt }],
			temperature: 0.7,
			max_tokens: 600,
		});

		const generatedPrompt = completion.choices[0]?.message?.content?.trim();

		if (!generatedPrompt) {
			res.status(500).json({ success: false, message: "Failed to generate prompt — empty response from AI" });
			return;
		}

		logger.info("Prompt builder: generated system prompt", {
			userId: req.user?.id,
			tone: promptConfig.tone,
			tokens: completion.usage?.total_tokens,
		});

		res.status(200).json({ success: true, prompt: generatedPrompt });
	} catch (error) {
		logger.error("Prompt builder: OpenAI error", { error });
		res.status(500).json({
			success: false,
			message: "Failed to generate prompt",
			details: error instanceof Error ? error.message : String(error),
		});
	}
};
