import { API_BASE_URL } from '$lib/api/client';

export interface RegistrationField {
	field_key: string;
	display_label: string;
	field_type: string;
	required: boolean;
	placeholder: string | null;
	validation_rules: Record<string, unknown> | null;
	order?: number;
}

const SIGNUP_BASE_FIELD_KEYS = new Set([
	'email',
	'field.canonical.email',
	'name',
	'field.canonical.name',
	'email_verified',
	'field.canonical.email_verified'
]);

export function isSignupBaseField(field: RegistrationField): boolean {
	return SIGNUP_BASE_FIELD_KEYS.has(field.field_key.trim().toLowerCase());
}

export function filterCustomRegistrationFields(fields: RegistrationField[]): RegistrationField[] {
	return fields.filter((field) => !isSignupBaseField(field));
}

export function resolveRegistrationFieldsUrl(apiBaseUrl = API_BASE_URL): string {
	const base = apiBaseUrl.trim();
	if (!base) {
		return '/api/v1/registration-fields';
	}

	return `${base.replace(/\/$/, '')}/api/v1/registration-fields`;
}

export async function fetchRegistrationFields(
	fetchFn: typeof fetch = fetch,
	apiBaseUrl = API_BASE_URL
): Promise<RegistrationField[]> {
	try {
		const response = await fetchFn(resolveRegistrationFieldsUrl(apiBaseUrl), {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			return [];
		}

		const data = (await response.json()) as { fields?: RegistrationField[] };
		return Array.isArray(data.fields) ? filterCustomRegistrationFields(data.fields) : [];
	} catch {
		return [];
	}
}
