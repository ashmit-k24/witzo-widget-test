import crypto from "crypto";

/**
 * UUID Utility
 * Generates unique string IDs for users
 */
class UuidUtil {
	/**
	 * Generate a UUID v4 (random UUID)
	 * Returns a unique long string in format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
	 */
	generateUuid(): string {
		return crypto.randomUUID();
	}

	/**
	 * Validate if a string is a valid UUID
	 */
	isValidUuid(uuid: string): boolean {
		const uuidRegex =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		return uuidRegex.test(uuid);
	}
}

export default new UuidUtil();
