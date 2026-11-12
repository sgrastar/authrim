import { isValidRedirectUrl } from './url-validation';

/** A form post as data (an authorization response in `form_post` mode): where, and the fields. */
export interface FormPostTarget {
	action: string;
	fields: Array<[string, string]>;
}

/**
 * The form post an answer asks for (`form_post: { action, fields: [[name, value], ...] }`), or
 * null when it has none or it cannot be used (an action the redirect rule refuses, a malformed
 * or oversized field list).
 */
export function readFormPost(answer: unknown): FormPostTarget | null {
	const raw =
		answer && typeof answer === 'object' ? (answer as Record<string, unknown>).form_post : null;
	if (!raw || typeof raw !== 'object') return null;
	const { action, fields } = raw as Record<string, unknown>;
	if (typeof action !== 'string' || !isValidRedirectUrl(action) || !Array.isArray(fields)) {
		return null;
	}
	const pairs = fields.filter(
		(field): field is [string, string] =>
			Array.isArray(field) &&
			field.length === 2 &&
			typeof field[0] === 'string' &&
			typeof field[1] === 'string'
	);
	return pairs.length === fields.length && pairs.length > 0 && pairs.length <= 20
		? { action, fields: pairs }
		: null;
}

/** Posts the fields to the action with a real form (hidden inputs), leaving this page. */
export function submitFormPost(target: FormPostTarget): void {
	const form = document.createElement('form');
	form.method = 'post';
	form.action = target.action;
	form.style.display = 'none';
	for (const [name, value] of target.fields) {
		const input = document.createElement('input');
		input.type = 'hidden';
		input.name = name;
		input.value = value;
		form.appendChild(input);
	}
	document.body.appendChild(form);
	form.submit();
}
