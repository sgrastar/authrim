/**
 * UUID validation utilities
 */

/**
 * Regular expression for validating UUID v4 format
 * Matches: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 * where x is a hexadecimal digit (0-9, a-f, A-F)
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate if a string is a valid UUID format
 * @param str - String to validate
 * @returns true if the string is a valid UUID format
 */
export function isValidUUID(str: string | null | undefined): boolean {
	if (!str) return false;
	return UUID_REGEX.test(str);
}
