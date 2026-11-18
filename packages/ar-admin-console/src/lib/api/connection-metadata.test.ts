import { t } from '#lib/i18n/i18n.svelte.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpSamlMetadata, httpSamlProviders, SAML_METADATA_MAX_BYTES } from './saml-providers';
import { emptyAnswers, emptyImport } from '#lib/pages/service-flows/connection-model.js';
import { spCreateInput, idpCreateInput } from '#lib/pages/service-flows/connection-creation.js';
import { boundedMetadataXml, metadataInput } from '#lib/pages/service-flows/metadata-draft.js';
import { setStepUpPrompt, StepUpCancelledError } from './admin-step-up';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: 'metadata-test' } }));
afterEach(() => vi.unstubAllGlobals());
const xml = '<synthetic-metadata-snapshot/>';
const source = 'https://metadata.example.test/sp.xml';
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const config = {
	entityId: 'urn:test:sp',
	acsUrl: 'https://sp.example.test/acs',
	certificates: ['public-test-certificate'],
	metadataXml: xml,
	metadataUrl: source
};

describe('single connection metadata HTTP client', () => {
	it('allows explicit activation after automatic recovery is blocked by a changed approval digest', async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				id: 'suspended',
				name: 'Suspended',
				providerType: 'saml_sp',
				enabled: false,
				updatedAt: '2026-11-18T00:00:00.000Z',
				config: {
					...config,
					identityMapping: { fieldMappingSetId: 'saml' },
					metadataRefreshPolicy: {
						sourceState: 'healthy',
						suspendedByMetadataSync: true,
						lastErrorCode: 'metadata_approval_required'
					}
				}
			})
		);
		vi.stubGlobal('fetch', fetcher);
		const detail = await httpSamlProviders.getServiceProvider('suspended');
		expect(detail.enabled).toBe(false);
		expect(detail.trustBlocked).toBe(false);
		expect(detail.hasMapping).toBe(true);
	});

	it('keeps draft creation and import silent, and prompts for L2 only on activation', async () => {
		const prompt = vi.fn(async () => false);
		const unregister = setStepUpPrompt(prompt);
		const row = {
			id: 'draft',
			name: 'Draft',
			providerType: 'saml_sp',
			enabled: false,
			updatedAt: '2026-11-18T00:00:00.000Z',
			config: {}
		};
		const fetcher = vi.fn(async (_url: string, init: RequestInit = {}) => {
			if (init.method === 'PUT')
				return Response.json(
					{
						error: 'step_up_required',
						required_level: 'L2',
						step_up_id: 'activation',
						missing: ['passkey', 'second_factor']
					},
					{ status: 403 }
				);
			if (String(_url).endsWith('/import-metadata'))
				return Response.json({
					...row,
					success: true,
					config: { entityId: config.entityId, acsUrl: config.acsUrl }
				});
			return Response.json(row, { status: 201 });
		});
		vi.stubGlobal('fetch', fetcher);
		try {
			await httpSamlProviders.createServiceProvider({
				name: 'Draft',
				providerType: 'saml_sp',
				enabled: false
			});
			await httpSamlMetadata.importMetadata('draft', {
				metadataXml: xml,
				expectedUpdatedAt: row.updatedAt
			});
			expect(prompt).not.toHaveBeenCalled();
			await expect(
				httpSamlProviders.setEnabled('draft', { enabled: true, expectedUpdatedAt: row.updatedAt })
			).rejects.toBeInstanceOf(StepUpCancelledError);
			expect(prompt).toHaveBeenCalledExactlyOnceWith({
				level: 'L2',
				factors: ['passkey', 'second_factor']
			});
			expect(fetcher).toHaveBeenCalledTimes(3);
		} finally {
			unregister();
		}
	});

	it.each(['wizard-sp', 'wizard-idp', 'details'])(
		'initializes %s XML input before switching modes and previewing pasted metadata',
		async (screen) => {
			const form =
				screen === 'details'
					? emptyImport(source)
					: screen === 'wizard-idp'
						? emptyAnswers(true).idp
						: emptyAnswers(true).sp;
			expect(form.importMode).toBe('url');
			expect(form.metadataXml).toBe('');
			form.importMode = 'xml';
			expect(() => metadataInput(form)).toThrow('Preview');
			const role = screen === 'wizard-idp' ? 'saml_idp' : 'saml_sp';
			const fetcher = vi.fn(async (_url: string, init: RequestInit = {}) => {
				expect(JSON.parse(String(init.body))).toEqual({ metadataXml: xml, providerType: role });
				return Response.json({
					kind: 'single',
					providerType: role,
					config: {
						entityId: 'urn:test:partner',
						acsUrl: 'https://sp.example.test/acs',
						ssoUrl: 'https://idp.example.test/sso',
						certificate: 'public-test-certificate',
						metadataXml: xml
					}
				});
			});
			vi.stubGlobal('fetch', fetcher);
			form.metadataXml = xml;
			form.metadata = {
				pending: false,
				error: '',
				sourceXml: form.metadataXml,
				preview: await httpSamlMetadata.preview({ metadataXml: form.metadataXml }, role)
			};
			expect(fetcher).toHaveBeenCalledOnce();
			expect(metadataInput(form)).toEqual({ metadataXml: xml });
			expect(emptyImport(source).metadataXml).toBe('');
		}
	);

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
		[{ kind: 'single', providerType: 'saml_idp', config }, t('sf.metadata.wrongRoleSp')],
		[{ kind: 'aggregate', previewId: 'fixture' }, t('sf.metadata.aggregate')],
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
						assertionValiditySeconds: 480,
						certificateValidation: { certificates: [{ fingerprintSha256: 'synthetic-summary' }] },
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
			address: config.acsUrl,
			hasMetadataUrl: true,
			config: { assertionValiditySeconds: 480 },
			certificateValidation: { certificates: [{ fingerprintSha256: 'synthetic-summary' }] }
		});
		expect(result.config).not.toHaveProperty('identityMapping');
		expect(result.config).not.toHaveProperty('metadataXml');
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

describe('deferred SAML inputs', () => {
	it('creates named SP and IdP drafts without metadata previews', () => {
		const answers = emptyAnswers(true);
		answers.sp.skipped = true;
		answers.idp.skipped = true;
		answers.idp.name = 'Draft IdP';
		expect(spCreateInput(answers, 'Draft SP')).toEqual({
			name: 'Draft SP',
			providerType: 'saml_sp',
			enabled: false
		});
		expect(idpCreateInput(answers.idp)).toEqual({
			name: 'Draft IdP',
			providerType: 'saml_idp',
			enabled: false,
			config: { jitEmailLinkingPolicy: 'disabled', allowSyntheticEmailFallback: false }
		});
	});
	it('keeps the safe IdP linking policy from skipped creation through metadata import and enable', async () => {
		let version = 0;
		const initialConfig: Record<string, unknown> = {};
		const row = {
			id: 'draft-idp',
			name: 'Draft IdP',
			providerType: 'saml_idp',
			enabled: false,
			updatedAt: '2026-11-18T00:00:00.000Z',
			config: initialConfig
		};
		const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
			const body: unknown = JSON.parse(String(init.body ?? '{}'));
			if (!object(body)) throw new Error('Expected object body');
			if (init.method === 'POST' && url.endsWith('/saml-providers')) {
				if (!object(body.config)) throw new Error('Expected safe IdP configuration');
				row.config = {
					jitEmailLinkingPolicy: 'email_linking',
					allowSyntheticEmailFallback: false,
					...body.config
				};
			} else if (init.method === 'POST' && url.endsWith('/import-metadata')) {
				expect(body.expectedUpdatedAt).toBe(row.updatedAt);
				row.config = {
					...row.config,
					entityId: 'urn:imported:idp',
					ssoUrl: 'https://idp.example.test/sso',
					certificate: 'public-test-certificate'
				};
			} else if (init.method === 'PUT') {
				expect(body).toEqual({ enabled: true, expectedUpdatedAt: row.updatedAt });
				row.enabled = true;
			} else if (init.method && init.method !== 'GET') throw new Error('Unexpected write');
			if (init.method && init.method !== 'GET')
				row.updatedAt = new Date(Date.UTC(2026, 10, 18, 0, 0, ++version)).toISOString();
			return Response.json({ ...row, success: true });
		});
		vi.stubGlobal('fetch', fetcher);
		const form = emptyAnswers(true).idp;
		form.name = row.name;
		form.skipped = true;
		const created = await httpSamlProviders.createIdentityProvider(idpCreateInput(form));
		const draft = await httpSamlProviders.getIdentityProvider(created.id);
		expect(draft.config).toMatchObject({
			jitEmailLinkingPolicy: 'disabled',
			allowSyntheticEmailFallback: false
		});
		const imported = await httpSamlMetadata.importMetadata(created.id, {
			metadataXml: xml,
			expectedUpdatedAt: draft.updatedAt
		});
		expect(imported.config).toMatchObject(draft.config ?? {});
		await httpSamlProviders.setEnabled(created.id, {
			enabled: true,
			expectedUpdatedAt: imported.updatedAt
		});
		const enabled = await httpSamlProviders.getIdentityProvider(created.id);
		expect(enabled.enabled).toBe(true);
		expect(enabled.config).toMatchObject({
			jitEmailLinkingPolicy: 'disabled',
			allowSyntheticEmailFallback: false
		});
	});
	it('requires a fresh preview of pasted XML, including when the server unwraps it', () => {
		const form = emptyAnswers(true).sp;
		form.importMode = 'xml';
		form.metadataXml = '<wrapped/>';
		form.metadata = {
			pending: false,
			error: '',
			sourceXml: '<wrapped/>',
			preview: {
				providerType: 'saml_sp',
				entityId: 'urn:sp',
				address: 'https://sp.example/acs',
				certificates: [],
				metadataXml: '<unwrapped/>'
			}
		};
		expect(metadataInput(form)).toEqual({ metadataXml: '<unwrapped/>' });
		form.metadataXml = '<changed/>';
		expect(() => metadataInput(form)).toThrow('Preview');
	});
	it.each([
		'metadata_fetch_failed',
		'metadata_invalid_xml',
		'metadata_aggregate_requires_federation'
	])('localizes %s from the server', async (code) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ error: 'invalid_request', error_description: code }, { status: 400 })
			)
		);
		const key =
			code === 'metadata_fetch_failed'
				? 'sf.metadata.fetchFailed'
				: code === 'metadata_invalid_xml'
					? 'sf.metadata.invalidXml'
					: 'sf.metadata.aggregate';
		await expect(httpSamlMetadata.preview({ metadataXml: xml }, 'saml_sp')).rejects.toThrow(t(key));
	});
});

it('keeps empty disabled SAML providers visible and reports the missing configuration', async () => {
	const row = {
		id: 'draft',
		name: 'Draft',
		enabled: false,
		updatedAt: '2026-11-18T00:00:00.000Z',
		config: {}
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) =>
			Response.json(
				url.endsWith('/saml-providers')
					? { providers: [{ ...row, providerType: 'saml_sp' }] }
					: { ...row, providerType: url.endsWith('/idp') ? 'saml_idp' : 'saml_sp' }
			)
		)
	);
	expect(await httpSamlProviders.listServiceProviders()).toEqual([
		{ id: 'draft', name: 'Draft', entityId: '', enabled: false }
	]);
	expect(await httpSamlProviders.getServiceProvider('sp')).toMatchObject({
		entityId: '',
		acsUrl: '',
		enabled: false,
		configurationMissing: true
	});
	expect(await httpSamlProviders.getIdentityProvider('idp')).toMatchObject({
		entityId: '',
		ssoUrl: '',
		certificate: '',
		enabled: false,
		configurationMissing: true
	});
});
