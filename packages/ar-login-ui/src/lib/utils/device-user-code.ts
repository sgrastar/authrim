/**
 * The user code a person types on the device page. The server issues codes of 4 to 16 letters and
 * digits (the tenant's `device_flow.user_code_length`), shown in groups of 4 separated by a hyphen,
 * and accepts them in any case with or without the separators. The page therefore takes any length
 * in that range and groups what is typed; it does not know the tenant's setting, and the code may
 * have been issued under an earlier one.
 */

export const USER_CODE_MIN_LENGTH = 4;
export const USER_CODE_MAX_LENGTH = 16;
export const USER_CODE_GROUP_SIZE = 4;

/**
 * The letters and digits of what was typed, upper case, at most 16. Full-width letters and digits
 * (what an IME produces in full-width alphanumeric mode) count as their ASCII forms; separators,
 * spaces and anything else are dropped.
 */
export function userCodeCharacters(value: string): string {
	return value
		.normalize('NFKC')
		.replace(/[^A-Za-z0-9]/g, '')
		.toUpperCase()
		.slice(0, USER_CODE_MAX_LENGTH);
}

/** The code in groups of 4 characters separated by a hyphen ("ABCD-EFGH-JKM"). */
export function formatUserCode(value: string): string {
	const characters = userCodeCharacters(value);
	const groups: string[] = [];
	for (let index = 0; index < characters.length; index += USER_CODE_GROUP_SIZE) {
		groups.push(characters.slice(index, index + USER_CODE_GROUP_SIZE));
	}
	return groups.join('-');
}

/** Whether what was typed is long enough to look up (4 to 16 characters). */
export function isUserCodeComplete(value: string): boolean {
	const length = userCodeCharacters(value).length;
	return length >= USER_CODE_MIN_LENGTH && length <= USER_CODE_MAX_LENGTH;
}
