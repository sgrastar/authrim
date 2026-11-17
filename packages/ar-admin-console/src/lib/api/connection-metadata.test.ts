import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpSamlMetadata, httpSamlProviders, SAML_METADATA_MAX_BYTES } from './saml-providers';
import { emptyAnswers } from '#lib/pages/service-flows/connection-model.js';
import { spCreateInput, idpCreateInput } from '#lib/pages/service-flows/connection-creation.js';
import { boundedMetadataXml, metadataInput } from '#lib/pages/service-flows/metadata-draft.js';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: 'metadata-test' } }));
afterEach(() => vi.unstubAllGlobals());
const xml = '<synthetic-metadata-snapshot/>';
const source = 'https://metadata.example.test/sp.xml';
const config = {
	entityId: 'urn:test:sp',
	acsUrl: 'https://sp.example.test/acs',
	certificates: ['public-test-certificate'],
	metadataXml: xml,
	metadataUrl: source
};

describe('single connection metadata HTTP client', () => {
	it('previews through the bounded server endpoint with expected role, tenant and cancellation; preview never creates', async () => {
		const controller = new AbortController();
		const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
			expect(url).toBe('/api/admin/saml-metadata/preview');
			expect(JSON.parse(String(init.body))).toEqual({
				metadataUrl: source,
				providerType: 'saml_sp'
			});
			expect(init.signal).toBe(controller.signal);
			expect(init.credentials).toBe('include');
			expect(new Headers(init.headers).get('X-Tenant-Id')).toBe('metadata-test');
			return Response.json({ kind: 'single', providerType: 'saml_sp', config });
		});
		vi.stubGlobal('fetch', fetcher);
		expect(
			await httpSamlMetadata.preview({ metadataUrl: source }, 'saml_sp', controller.signal)
		).toEqual({
			providerType: 'saml_sp',
			entityId: config.entityId,
			address: config.acsUrl,
			certificates: config.certificates,
			metadataXml: xml,
			metadataUrl: source
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it.each([
		[{ kind: 'single', providerType: 'saml_idp', config }, 'role'],
		[{ kind: 'aggregate', previewId: 'fixture' }, 'federation'],
		[{ kind: 'single', providerType: 'saml_sp', config: {} }, 'Invalid']
	])('rejects unsupported preview responses', async (body, message) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(body))
		);
		await expect(httpSamlMetadata.preview({ metadataXml: xml }, 'saml_sp')).rejects.toThrow(
			String(message)
		);
	});

	it('retains the actual XML and source through explicit create and import, without sending mapping or defaults', async () => {
		const writes: unknown[] = [];
		const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
			writes.push(JSON.parse(String(init.body)));
			if (url.endsWith('/import-metadata'))
				return Response.json({
					success: true,
					providerType: 'saml_sp',
					config: {
						...config,
						identityMapping: {
							fieldMappingSetId: 'saved-set',
							fieldMappingVersionId: 'saved-version'
						}
					},
					enabled: false,
					updatedAt: '2026-11-17T00:00:01.000Z'
				});
			return Response.json({ id: 'provider/a' }, { status: 201 });
		});
		vi.stubGlobal('fetch', fetcher);
		const answers = emptyAnswers();
		answers.sp.importMode = 'url';
		answers.sp.metadataUrl = source;
		answers.sp.metadata = {
			pending: false,
			error: '',
			preview: {
				providerType: 'saml_sp',
				entityId: config.entityId,
				address: config.acsUrl,
				certificates: config.certificates,
				metadataXml: xml,
				metadataUrl: source
			}
		};
		await httpSamlProviders.createServiceProvider(spCreateInput(answers, 'New service'));
		expect(writes[0]).toEqual({
			name: 'New service',
			providerType: 'saml_sp',
			enabled: false,
			metadataXml: xml,
			metadataUrl: source
		});
		const result = await httpSamlMetadata.importMetadata('provider/a', {
			...metadataInput(answers.sp),
			expectedUpdatedAt: '2026-11-17T00:00:00.000Z'
		});
		expect(fetcher.mock.calls[1][0]).toBe('/api/admin/saml-providers/provider%2Fa/import-metadata');
		expect(writes[1]).toEqual({
			expectedUpdatedAt: '2026-11-17T00:00:00.000Z',
			metadataXml: xml,
			metadataUrl: source
		});
		expect(result).toMatchObject({
			hasMapping: true,
			enabled: false,
			updatedAt: '2026-11-17T00:00:01.000Z',
			entityId: config.entityId,
			address: config.acsUrl
		});
	});

	it('requires the current successful preview and refuses stale, pending and wrong-role creation without changing manual values', () => {
		const answers = emptyAnswers();
		const form = answers.sp;
		Object.assign(form, {
			importMode: 'url',
			metadataUrl: source,
			entityId: 'urn:manual:draft',
			acsUrl: 'https://manual.example.test/acs'
		});
		expect(() => spCreateInput(answers, 'Service')).toThrow('Preview');
		form.metadata = {
			pending: true,
			error: '',
			preview: {
				providerType: 'saml_sp',
				entityId: config.entityId,
				address: config.acsUrl,
				certificates: [],
				metadataXml: xml,
				metadataUrl: source
			}
		};
		expect(() => spCreateInput(answers, 'Service')).toThrow('Preview');
		form.metadata.pending = false;
		form.metadataUrl = 'https://changed.example.test/metadata';
		expect(() => spCreateInput(answers, 'Service')).toThrow('Preview');
		form.importMode = 'manual';
		expect(spCreateInput(answers, 'Service').config).toMatchObject({
			entityId: 'urn:manual:draft',
			acsUrl: 'https://manual.example.test/acs'
		});
	});

	it('creates an IdP from uploaded XML with safe JIT defaults and no fabricated settings', () => {
		const form = emptyAnswers().idp;
		const file = new File([xml], 'idp.xml', { type: 'application/xml' });
		Object.assign(form, {
			name: 'Identity',
			importMode: 'file',
			metadata: {
				pending: false,
				error: '',
				file,
				preview: {
					providerType: 'saml_idp',
					entityId: 'urn:idp',
					address: 'https://idp.example.test/sso',
					certificates: ['public'],
					metadataXml: xml
				}
			}
		});
		expect(idpCreateInput(form)).toEqual({
			name: 'Identity',
			providerType: 'saml_idp',
			enabled: false,
			metadataXml: xml,
			config: { jitEmailLinkingPolicy: 'disabled', allowSyntheticEmailFallback: false }
		});
	});

	it('enforces UTF-8 XML and escaped JSON payload limits', () => {
		expect(() => boundedMetadataXml('x'.repeat(SAML_METADATA_MAX_BYTES + 1))).toThrow('size limit');
		expect(() => boundedMetadataXml('あ'.repeat(SAML_METADATA_MAX_BYTES / 3 + 1))).toThrow(
			'size limit'
		);
		expect(() => boundedMetadataXml('"'.repeat(SAML_METADATA_MAX_BYTES))).toThrow('size limit');
	});
});
