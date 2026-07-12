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
		return Array.isArray(data.fields) ? data.fields : [];
	} catch {
		return [];
	}
}
