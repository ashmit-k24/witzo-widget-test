/**
 * Langfuse is currently optional in this repo.
 * Until the package and env config are added back, keep tracing as no-op
 * so the rest of the app compiles and runs normally.
 */

type LangfuseSpanImpl = {
	end: (payload?: {
		output?: unknown;
		metadata?: Record<string, any>;
	}) => void;
};

type LangfuseTraceImpl = {
	span: (payload: {
		name: string;
		input?: unknown;
	}) => LangfuseSpanImpl;
	generation: (payload: {
		name: string;
		model: string;
		input: unknown;
		output: string;
		usage?: {
			input: number;
			output: number;
			total: number;
		};
		metadata?: Record<string, any>;
	}) => void;
	update: (payload: {
		output?: string;
		metadata?: Record<string, any>;
	}) => void;
};

export type LangfuseTrace = LangfuseTraceImpl | null;
export type LangfuseSpan = LangfuseSpanImpl | null;

/**
 * Start a top-level trace for a chat request.
 */
export function startChatTrace(params: {
	userId: string;
	sessionId: string;
	message: string;
	intent?: string;
}): LangfuseTrace {
	void params;
	return null;
}

/**
 * Start a span inside a trace (for a specific operation).
 */
export function startSpan(
	trace: LangfuseTrace,
	name: string,
	input?: any,
): LangfuseSpan {
	void name;
	void input;
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
	return Promise.resolve();
}
