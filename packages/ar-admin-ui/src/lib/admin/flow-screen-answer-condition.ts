/**
 * The values of a Flow screen answer condition (`screen.answer`) as the flow editor edits them:
 * one per line. A choice's value may hold spaces, commas or even line breaks, so a value is never
 * split here: a line break or a backslash inside a value is written `\n` (`\r`) or `\\` on its line.
 */

const escape = (value: string) =>
	value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

const unescape = (line: string) =>
	line.replace(/\\(\\|n|r)/g, (_match, code: string) =>
		code === 'n' ? '\n' : code === 'r' ? '\r' : '\\'
	);

/** The values a condition holds, one per line. */
export function screenAnswerValuesToDraft(condition: Record<string, unknown>): string {
	if (Array.isArray(condition.values)) {
		return condition.values.map((value) => escape(String(value))).join('\n');
	}
	return condition.value === undefined || condition.value === null
		? ''
		: escape(String(condition.value));
}

/** The lines as the condition's `value` (one) or `values` (more), each trimmed. */
export function screenAnswerDraftToValues(draft: string): { value: string } | { values: string[] } {
	const values = draft
		.split(/\r?\n/)
		.map((line) => unescape(line.trim()))
		.filter(Boolean);
	return values.length > 1 ? { values } : { value: values[0] ?? '' };
}
