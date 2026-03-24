export const USER_PASSWORD_MIN_LENGTH = 8;
export const USER_PASSWORD_MAX_LENGTH = 256;

export const USER_PASSWORD_POLICY_MESSAGE =
	`Password must be at least ${USER_PASSWORD_MIN_LENGTH} characters and include an uppercase letter, a lowercase letter, and a number.`;

export function isStrongUserPassword(
	password: string,
): boolean {
	return (
		password.length >= USER_PASSWORD_MIN_LENGTH &&
		password.length <= USER_PASSWORD_MAX_LENGTH &&
		/[A-Z]/.test(password) &&
		/[a-z]/.test(password) &&
		/[0-9]/.test(password)
	);
}
