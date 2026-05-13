// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fetchRegistrationFields, resolveRegistrationFieldsUrl } from './registration-fields';

describe('registration-fields API', () => {
	it('uses a relative path when no explicit API base URL is configured', () => {
		expect(resolveRegistrationFieldsUrl('')).toBe('/api/v1/registration-fields');
	});

	it('uses the configured API base URL for cross-origin deployments', () => {
		expect(resolveRegistrationFieldsUrl('https://auth.example.com')).toBe(
			'https://auth.example.com/api/v1/registration-fields'
		);
		expect(resolveRegistrationFieldsUrl('https://auth.example.com/')).toBe(
			'https://auth.example.com/api/v1/registration-fields'
		);
	});

	it('fetches registration fields with credentials included', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
			ok: true,
			json: async () => ({
				fields: [
					{
						field_key: 'department',
						display_label: 'Department',
						field_type: 'string',
						required: true,
						placeholder: 'Engineering',
						validation_rules: null
					}
				]
			})
		} as Response);

		const result = await fetchRegistrationFields(fetchMock, 'https://auth.example.com');

		expect(fetchMock).toHaveBeenCalledWith('https://auth.example.com/api/v1/registration-fields', {
			method: 'GET',
			credentials: 'include'
		});
		expect(result).toEqual([
			{
				field_key: 'department',
				display_label: 'Department',
				field_type: 'string',
				required: true,
				placeholder: 'Engineering',
				validation_rules: null
			}
		]);
	});

	it('returns an empty array when the request fails', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('network error'));

		await expect(fetchRegistrationFields(fetchMock, 'https://auth.example.com')).resolves.toEqual(
			[]
		);
	});
});
