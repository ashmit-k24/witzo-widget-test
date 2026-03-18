import { Langfuse } from "langfuse";
import { config } from "../config/env";
import logger from "./logger";

/**
 * Lightweight Langfuse wrapper.
 * All methods are no-ops when LANGFUSE_SECRET_KEY is not set,
 * so the app works fine without the observability service configured.
 */

let _client: Langfuse | null = null;

function getClient(): Langfuse | null {
	if (_client) return _client;
	if (!config.LANGFUSE_SECRET_KEY || !config.LANGFUSE_PUBLIC_KEY) {
		return null;
	}
	try {
		_client = new Langfuse({
			secretKey: config.LANGFUSE_SECRET_KEY,
			publicKey: config.LANGFUSE_PUBLIC_KEY,
			baseUrl: config.LANGFUSE_HOST || "https://cloud.langfuse.com",
			flushAt: 10,
			flushInterval: 5000,
		});
		logger.info("[Langfuse] Observability enabled");
	} catch (error) {
		logger.warn("[Langfuse] Failed to initialize client", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return _client;
}

export type LangfuseTrace = ReturnType<Langfuse["trace"]> | null;
export type LangfuseSpan = ReturnType<NonNullable<LangfuseTrace>["span"]> | null;

/**
 * Start a top-level trace for a chat request.
 */
export function startChatTrace(params: {
	userId: string;
	sessionId: string;
	message: string;
	intent?: string;
}): LangfuseTrace {
	const client = getClient();
	if (!client) return null;
	try {
		return client.trace({
			name: "chat",
			userId: params.userId,
			sessionId: params.sessionId,
			input: params.message.slice(0, 500),
			metadata: {
				intent: params.intent,
			},
		});
	} catch {
		return null;
	}
}

/**
 * Start a span inside a trace (for a specific operation).
 */
export function startSpan(
	trace: LangfuseTrace,
	name: string,
	input?: any,
): LangfuseSpan {
	if (!trace) return null;
	try {
		return trace.span({ name, input });
	} catch {
		return null;
	}
}

/**
 * End a span with output and optional metadata.
 */
export function endSpan(
	span: LangfuseSpan,
	output?: any,
	metadata?: Record<string, any>,
): void {
	if (!span) return;
	try {
		span.end({ output, metadata });
	} catch {
		// ignore
	}
}

/**
 * Record an LLM generation inside a trace.
 */
export function recordGeneration(
	trace: LangfuseTrace,
	params: {
		name: string;
		model: string;
		input: any;
		output: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		metadata?: Record<string, any>;
	},
): void {
	if (!trace) return;
	try {
		trace.generation({
			name: params.name,
			model: params.model,
			input: params.input,
			output: params.output,
			usage: {
				input: params.promptTokens ?? 0,
				output: params.completionTokens ?? 0,
				total: params.totalTokens ?? 0,
			},
			metadata: params.metadata,
		});
	} catch {
		// ignore
	}
}

/**
 * Finalize the trace with the final response.
 */
export function endTrace(
	trace: LangfuseTrace,
	output: string,
	metadata?: Record<string, any>,
): void {
	if (!trace) return;
	try {
		trace.update({ output: output.slice(0, 500), metadata });
	} catch {
		// ignore
	}
}

/**
 * Flush all pending events (call on graceful shutdown).
 */
export async function flushLangfuse(): Promise<void> {
	if (!_client) return;
	try {
		await _client.flushAsync();
	} catch {
		// ignore
	}
}
