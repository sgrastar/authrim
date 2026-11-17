import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpInboundMapping, type InboundMappingDraft } from './inbound-mapping';
import { STEP_UP_RECEIPT_HEADER } from './admin-step-up';
import { inboundMappingFixture } from '#lib/pages/service-flows/inbound-mapping.fixture.js';
vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({
	tenantScope: { tenantId: 'synthetic-tenant' }
}));
afterEach(() => vi.unstubAllGlobals());

describe('incoming mapping HTTP contract', () => {
	it('reads/saves the distinct provider-owned DTO with its revision and stable operation key', async () => {
		const fixture = inboundMappingFixture('op', true);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => new Response(JSON.stringify(fixture.document)));
		vi.stubGlobal('fetch', fetcher);
		const document = await httpInboundMapping.get('op', 'provider/one');
		const draft: InboundMappingDraft = {
			revision: document.revision,
			rules: document.content.rules,
			sources: document.sources.map(({ namespace, path, cardinality }) => ({
				namespace,
				path,
				cardinality
			}))
		};
		await httpInboundMapping.save('op', 'provider/one', draft, 'incoming-operation');
		expect(fetcher.mock.calls[0][0]).toBe('/api/admin/identity-mapping/inbound/op/provider%2Fone');
		const [url, init] = fetcher.mock.calls[1];
		expect(url).toBe('/api/admin/identity-mapping/inbound/op/provider%2Fone');
		expect(init?.method).toBe('PUT');
		expect(init?.credentials).toBe('include');
		expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('incoming-operation');
		expect(init?.body).toBe(JSON.stringify(draft));
	});
	it('sends only a preview POST with the standard transport key and no step-up receipt', async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ profile: { email: 'sample@example.test' }, customClaims: {} })
				)
			);
		vi.stubGlobal('fetch', fetcher);
		const draft: InboundMappingDraft = { revision: 'incoming-1', sources: [], rules: [] };
		const sample = { 'saml.attribute': { mail: 'sample@example.test' } };
		await expect(
			httpInboundMapping.preview('idp', 'provider/one', draft, sample)
		).resolves.toMatchObject({ profile: { email: 'sample@example.test' } });
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe('/api/admin/identity-mapping/inbound/idp/provider%2Fone/preview');
		expect(init?.method).toBe('POST');
		expect(init?.credentials).toBe('include');
		const headers = new Headers(init?.headers);
		expect(headers.get('Idempotency-Key')).toBeTruthy();
		expect(headers.get('X-Tenant-Id')).toBe('synthetic-tenant');
		expect(headers.get('Content-Type')).toBe('application/json');
		expect(headers.has(STEP_UP_RECEIPT_HEADER)).toBe(false);
		expect(init?.body).toBe(JSON.stringify({ ...draft, sample }));
	});
});
