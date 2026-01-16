import logger from "./logger";

/**
 * Retry utility with exponential backoff
 * Used for transient failures in external API calls
 */

interface RetryOptions {
	maxRetries: number;
	initialDelay: number; // in milliseconds
	maxDelay: number; // maximum delay between retries
	backoffMultiplier: number; // multiplier for exponential backoff
	retryableErrors?: string[]; // specific error messages/codes to retry
	name?: string; // for logging
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
	maxRetries: 3,
	initialDelay: 1000,
	maxDelay: 30000,
	backoffMultiplier: 2,
	name: "RetryOperation",
};

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: Partial<RetryOptions> = {},
): Promise<T> {
	const opts = {
		...DEFAULT_RETRY_OPTIONS,
		...options,
	};
	let lastError: Error;
	let delay = opts.initialDelay;

	for (
		let attempt = 0;
		attempt <= opts.maxRetries;
		attempt++
	) {
		try {
			const result = await fn();

			if (attempt > 0) {
				logger.info("Retry succeeded", {
					name: opts.name,
					attempt,
					totalAttempts: attempt + 1,
				});
			}

			return result;
		} catch (error) {
			lastError = error as Error;

			// Check if error is retryable
			if (
				opts.retryableErrors &&
				opts.retryableErrors.length > 0
			) {
				const isRetryable =
					opts.retryableErrors.some((errMsg) =>
						lastError.message.includes(errMsg),
					);
				if (!isRetryable) {
					logger.warn(
						"Error is not retryable, failing immediately",
						{
							name: opts.name,
							error: lastError.message,
						},
					);
					throw lastError;
				}
			}

			if (attempt < opts.maxRetries) {
				logger.warn(
					"Retry attempt failed, will retry",
					{
						name: opts.name,
						attempt: attempt + 1,
						maxRetries: opts.maxRetries,
						nextRetryIn: delay,
						error: lastError.message,
					},
				);

				// Wait before retrying
				await sleep(delay);

				// Calculate next delay with exponential backoff
				delay = Math.min(
					delay * opts.backoffMultiplier,
					opts.maxDelay,
				);
			} else {
				logger.error(
					"All retry attempts failed",
					{
						name: opts.name,
						totalAttempts: attempt + 1,
						error: lastError.message,
					},
				);
			}
		}
	}

	throw lastError!;
}

/**
 * Retry specifically for API rate limit errors (429)
 */
export async function retryOnRateLimit<T>(
	fn: () => Promise<T>,
	maxRetries: number = 5,
): Promise<T> {
	return retryWithBackoff(fn, {
		maxRetries,
		initialDelay: 2000,
		maxDelay: 60000,
		backoffMultiplier: 2,
		retryableErrors: [
			"429",
			"rate limit",
			"too many requests",
		],
		name: "RateLimitRetry",
	});
}

/**
 * Retry for network/timeout errors
 */
export async function retryOnNetworkError<T>(
	fn: () => Promise<T>,
	maxRetries: number = 3,
): Promise<T> {
	return retryWithBackoff(fn, {
		maxRetries,
		initialDelay: 1000,
		maxDelay: 10000,
		backoffMultiplier: 2,
		retryableErrors: [
			"ECONNRESET",
			"ETIMEDOUT",
			"ENOTFOUND",
			"ECONNREFUSED",
			"network",
			"timeout",
		],
		name: "NetworkErrorRetry",
	});
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) =>
		setTimeout(resolve, ms),
	);
}

/**
 * Batch retry - useful for bulk operations
 * Retries failed items separately
 */
export async function retryBatch<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	options: Partial<RetryOptions> = {},
): Promise<{
	successes: R[];
	failures: Array<{ item: T; error: Error }>;
}> {
	const successes: R[] = [];
	const failures: Array<{
		item: T;
		error: Error;
	}> = [];

	for (const item of items) {
		try {
			const result = await retryWithBackoff(
				() => fn(item),
				options,
			);
			successes.push(result);
		} catch (error) {
			failures.push({
				item,
				error: error as Error,
			});
		}
	}

	return { successes, failures };
}
