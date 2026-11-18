import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { handleDevAdminMock } from './dev-console-mock';
import { metadataXml } from '#lib/api/fake/metadata-fixture.js';

function event(path: string, method: string, body?: Record<string, unknown>): RequestEvent {
	const url = new URL(`/api/admin/${path}`, 'http://localhost');
	return {
		url,
		request: new Request(url, {
			method,
			...(body
				? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
				: {})
		}),
		get cookies(): never {
			throw new Error('Cookies are unused by these fixtures');
		},
		get tracing(): never {
			throw new Error('Tracing is unused by these fixtures');
		},
		fetch: () => {
			throw new Error('The dev mock must not fetch metadata');
		},
		getClientAddress: () => '127.0.0.1',
		locals: {},
		params: {},
		platform: undefined,
		route: { id: null },
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	};
}
function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
async function ask(path: string, method: string, body?: Record<string, unknown>, status = 200) {
	const response = await handleDevAdminMock(event(path, method, body), {
		AUTHRIM_ADMIN_UI_DEV_MOCK: 'true'
	});
	expect(response?.status).toBe(status);
	if (!response) throw new Error('Expected the local mock to handle the request');
	const parsed: unknown = await response.json();
	if (!object(parsed)) throw new Error('Expected an object response');
	return parsed;
}

describe('local connection creation and metadata import', () => {
	it.each(['saml_sp', 'saml_idp'])(
		'previews, creates and reimports a %s draft without external fetches',
		async (providerType) => {
			const preview = await ask('saml-metadata/preview', 'POST', {
				providerType,
				metadataXml: metadataXml(providerType === 'saml_sp' ? 'saml_sp' : 'saml_idp')
			});
			expect(preview).toMatchObject({ kind: 'single', providerType });
			const created = await ask(
				'saml-providers',
				'POST',
				{ name: 'Draft', providerType, enabled: false },
				201
			);
			expect(created.config).toEqual({});
			expect(created.enabled).toBe(false);
			const id = String(created.id);
			const imported = await ask(`saml-providers/${id}/import-metadata`, 'POST', {
				expectedUpdatedAt: created.updatedAt,
				metadataXml: metadataXml(providerType === 'saml_sp' ? 'saml_sp' : 'saml_idp')
			});
			expect(imported).toMatchObject({
				success: true,
				enabled: false,
				config: { entityId: `urn:synthetic:${providerType}` }
			});
			expect(imported.updatedAt).not.toBe(created.updatedAt);
			const reopened = await ask(`saml-providers/${id}`, 'GET');
			expect(reopened.config).toEqual(imported.config);
			await ask(
				`saml-providers/${id}/import-metadata`,
				'POST',
				{ expectedUpdatedAt: created.updatedAt, metadataXml: metadataXml('saml_sp') },
				409
			);
		}
	);
	it('creates an OIDC client and retains its redirect URIs on reopen', async () => {
		const created = await ask(
			'clients',
			'POST',
			{ client_name: 'Portal', redirect_uris: ['https://portal.example/callback'] },
			201
		);
		if (!object(created.client)) throw new Error('Expected the client response envelope');
		const reopened = await ask(`clients/${String(created.client.client_id)}`, 'GET');
		expect(reopened).toMatchObject({
			client: { client_name: 'Portal', redirect_uris: ['https://portal.example/callback'] }
		});
	});
});
