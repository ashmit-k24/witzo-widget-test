/**
 * Simple in-memory key-value cache with TTL support.
 * Drop-in replacement for the Redis cache calls used across services.
 * Values are always stored as strings (same contract as ioredis).
 */

interface CacheEntry {
	value: string;
	expiresAt: number; // epoch ms, 0 = no expiry
}

class MemCache {
	private store = new Map<string, CacheEntry>();
	private sweepIntervalMs: number;
	private sweepTimer: NodeJS.Timeout | null = null;

	constructor(sweepIntervalMs = 60_000) {
		this.sweepIntervalMs = sweepIntervalMs;
		this.startSweep();
	}

	/** Get a value, returns null if missing or expired. */
	get(key: string): string | null {
		const entry = this.store.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return null;
		}
		return entry.value;
	}

	/** Set a value with a TTL in seconds (0 = no expiry). */
	setex(key: string, ttlSeconds: number, value: string): void {
		const expiresAt =
			ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
		this.store.set(key, { value, expiresAt });
	}

	/** Set a value with no expiry. */
	set(key: string, value: string): void {
		this.store.set(key, { value, expiresAt: 0 });
	}

	/** Delete a key. Returns 1 if deleted, 0 if not found. */
	del(key: string): number {
		return this.store.delete(key) ? 1 : 0;
	}

	/** Increment an integer value, returns the new value. */
	incr(key: string): number {
		const current = this.get(key);
		const next = (current ? parseInt(current, 10) : 0) + 1;
		const entry = this.store.get(key);
		this.store.set(key, {
			value: String(next),
			expiresAt: entry?.expiresAt ?? 0,
		});
		return next;
	}

	/** Decrement an integer value, returns the new value. */
	decr(key: string): number {
		const current = this.get(key);
		const next = (current ? parseInt(current, 10) : 0) - 1;
		const entry = this.store.get(key);
		this.store.set(key, {
			value: String(next),
			expiresAt: entry?.expiresAt ?? 0,
		});
		return next;
	}

	/** Remove all expired entries. */
	sweep(): void {
		const now = Date.now();
		for (const [key, entry] of this.store) {
			if (entry.expiresAt !== 0 && now > entry.expiresAt) {
				this.store.delete(key);
			}
		}
	}

	/** Current number of keys (including possibly-expired ones not yet swept). */
	size(): number {
		return this.store.size;
	}

	private startSweep(): void {
		this.sweepTimer = setInterval(
			() => this.sweep(),
			this.sweepIntervalMs,
		);
		// Don't block process exit
		if (this.sweepTimer.unref) {
			this.sweepTimer.unref();
		}
	}
}

export const memCache = new MemCache();
