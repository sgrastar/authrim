import { describe, expect, it, vi } from 'vitest';
import type { AccountCapabilities } from '$lib/api/account';
import { loadAccountPageInitialData } from './account-page-initial-data';

function capabilitiesWithConditions(
	conditions: NonNullable<
		AccountCapabilities['account_page']
	>['definition']['screens'][number]['condition'][]
): AccountCapabilities {
	return {
		capabilities: [],
		sections: [],
		theme: {
			version: 1,
			scope: 'account',
			source: 'test',
			account_page_overrides_supported: true,
			planned_tokens: []
		},
		account_page: {
			definition: {
				schema_version: 'authrim.account_page.v1',
				screens: conditions.map((condition, index) => ({
					id: `placement-${index}`,
					screen_key: `screen-${index}`,
					width: 'half',
					enabled: true,
					condition
				}))
			},
			screens: [],
			version: 1,
			published_at: '2026-08-09T00:00:00.000Z'
		}
	};
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('loadAccountPageInitialData', () => {
	it('loads only the published composition when no data-dependent conditions are configured', async () => {
		const capabilities = capabilitiesWithConditions(['always', 'passkey_enabled']);
		const fetch = vi.fn(async () => jsonResponse(capabilities));

		const result = await loadAccountPageInitialData(fetch);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith('/api/account/capabilities', expect.any(Object));
		expect(result).toEqual({
			capabilities,
			capabilitiesResolved: true,
			placementConditions: {
				consentRecordsAvailable: null,
				multipleSessions: null
			}
		});
	});

	it('pre-resolves configured data-dependent conditions to keep the first grid stable', async () => {
		const capabilities = capabilitiesWithConditions([
			'consent_records_available',
			'multiple_sessions'
		]);
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const path = input.toString();
			if (path === '/api/account/capabilities') return jsonResponse(capabilities);
			if (path === '/api/account/consents') return jsonResponse({ consents: [{ id: 'consent' }] });
			if (path === '/api/account/sessions') {
				return jsonResponse({ sessions: [{ id: 'one' }, { id: 'two' }] });
			}
			return jsonResponse({}, 404);
		});

		const result = await loadAccountPageInitialData(fetch, 'ja_JP');

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(fetch).toHaveBeenCalledWith(
			'/api/account/consents',
			expect.objectContaining({
				headers: expect.objectContaining({ 'Accept-Language': 'ja-JP' }),
				cache: 'no-store'
			})
		);
		expect(result.placementConditions).toEqual({
			consentRecordsAvailable: true,
			multipleSessions: true
		});
	});

	it('keeps the composition unresolved when the authenticated bootstrap request fails', async () => {
		const fetch = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));

		await expect(loadAccountPageInitialData(fetch)).resolves.toEqual({
			capabilities: null,
			capabilitiesResolved: false,
			placementConditions: {
				consentRecordsAvailable: null,
				multipleSessions: null
			}
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
