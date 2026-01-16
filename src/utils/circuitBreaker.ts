import logger from "./logger";

/**
 * Circuit Breaker pattern implementation
 * Prevents cascading failures when external services are down
 */

enum CircuitState {
	CLOSED = "CLOSED", // Normal operation
	OPEN = "OPEN", // Service is failing, reject requests immediately
	HALF_OPEN = "HALF_OPEN", // Testing if service has recovered
}

interface CircuitBreakerOptions {
	failureThreshold: number; // Number of failures before opening circuit
	successThreshold: number; // Number of successes in half-open state to close circuit
	timeout: number; // Time in ms to wait before trying again (half-open)
	name: string; // Circuit breaker name for logging
}

export class CircuitBreaker {
	private state: CircuitState =
		CircuitState.CLOSED;
	private failureCount: number = 0;
	private successCount: number = 0;
	private nextAttempt: number = Date.now();
	private readonly options: CircuitBreakerOptions;

	constructor(options: CircuitBreakerOptions) {
		this.options = options;
	}

	async execute<T>(
		fn: () => Promise<T>,
	): Promise<T> {
		if (this.state === CircuitState.OPEN) {
			if (Date.now() < this.nextAttempt) {
				const error = new Error(
					`Circuit breaker is OPEN for ${this.options.name}`,
				);
				logger.warn(
					"Circuit breaker rejected request",
					{
						name: this.options.name,
						state: this.state,
						nextAttempt: new Date(
							this.nextAttempt,
						).toISOString(),
					},
				);
				throw error;
			}
			// Move to half-open to test service
			this.state = CircuitState.HALF_OPEN;
			logger.info(
				"Circuit breaker entering HALF_OPEN state",
				{
					name: this.options.name,
				},
			);
		}

		try {
			const result = await fn();
			this.onSuccess();
			return result;
		} catch (error) {
			this.onFailure();
			throw error;
		}
	}

	private onSuccess(): void {
		this.failureCount = 0;

		if (this.state === CircuitState.HALF_OPEN) {
			this.successCount++;
			logger.debug(
				"Circuit breaker success in HALF_OPEN",
				{
					name: this.options.name,
					successCount: this.successCount,
					successThreshold:
						this.options.successThreshold,
				},
			);

			if (
				this.successCount >=
				this.options.successThreshold
			) {
				this.state = CircuitState.CLOSED;
				this.successCount = 0;
				logger.info(
					"Circuit breaker CLOSED (service recovered)",
					{
						name: this.options.name,
					},
				);
			}
		}
	}

	private onFailure(): void {
		this.failureCount++;
		this.successCount = 0;

		logger.warn(
			"Circuit breaker recorded failure",
			{
				name: this.options.name,
				failureCount: this.failureCount,
				failureThreshold:
					this.options.failureThreshold,
				state: this.state,
			},
		);

		if (
			this.failureCount >=
			this.options.failureThreshold
		) {
			this.state = CircuitState.OPEN;
			this.nextAttempt =
				Date.now() + this.options.timeout;

			logger.error(
				"Circuit breaker OPEN (too many failures)",
				{
					name: this.options.name,
					failureCount: this.failureCount,
					nextAttempt: new Date(
						this.nextAttempt,
					).toISOString(),
				},
			);
		}
	}

	getState(): CircuitState {
		return this.state;
	}

	getMetrics() {
		return {
			state: this.state,
			failureCount: this.failureCount,
			successCount: this.successCount,
			nextAttempt:
				this.state === CircuitState.OPEN
					? new Date(
							this.nextAttempt,
						).toISOString()
					: null,
		};
	}

	// Manual reset (for admin purposes)
	reset(): void {
		this.state = CircuitState.CLOSED;
		this.failureCount = 0;
		this.successCount = 0;
		this.nextAttempt = Date.now();
		logger.info(
			"Circuit breaker manually reset",
			{
				name: this.options.name,
			},
		);
	}
}

/**
 * Pre-configured circuit breakers for external services
 */

// OpenAI API circuit breaker
export const openAICircuitBreaker =
	new CircuitBreaker({
		failureThreshold: 5, // Open after 5 consecutive failures
		successThreshold: 2, // Close after 2 consecutive successes
		timeout: 60000, // Wait 1 minute before retrying
		name: "OpenAI API",
	});

// Pinecone API circuit breaker
export const pineconeCircuitBreaker =
	new CircuitBreaker({
		failureThreshold: 5,
		successThreshold: 2,
		timeout: 30000, // Wait 30 seconds before retrying
		name: "Pinecone API",
	});

// Email service circuit breaker
export const emailCircuitBreaker =
	new CircuitBreaker({
		failureThreshold: 3,
		successThreshold: 2,
		timeout: 120000, // Wait 2 minutes before retrying
		name: "Email Service",
	});

/**
 * Helper function to wrap any async function with a circuit breaker
 */
export async function withCircuitBreaker<T>(
	circuitBreaker: CircuitBreaker,
	fn: () => Promise<T>,
	fallback?: () => Promise<T>,
): Promise<T> {
	try {
		return await circuitBreaker.execute(fn);
	} catch (error) {
		if (fallback) {
			logger.info(
				"Circuit breaker using fallback",
				{
					name: circuitBreaker.getMetrics().state,
				},
			);
			return await fallback();
		}
		throw error;
	}
}
