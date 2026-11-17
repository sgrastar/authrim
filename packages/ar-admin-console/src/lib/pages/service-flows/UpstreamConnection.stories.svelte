<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { inboundMappingFixture } from './inbound-mapping.fixture';
	import { ApiError } from '#lib/api/api-error.js';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type {
		ExternalProvider,
		ExternalProvidersClient,
		OidcDiscovery
	} from '#lib/api/external-providers.js';
	import type {
		SamlIdentityProvider,
		SamlIdentityProvidersClient
	} from '#lib/api/saml-providers.js';
	import UpstreamConnectionHarness from './UpstreamConnectionHarness.svelte';
	import type { ConnectionCreationResources } from './connection-creation';
	import type { ConnectionKind } from './connection-model';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Upstream connections',
		component: UpstreamConnectionHarness,
		parameters: { layout: 'fullscreen' }
	});
	const discovery: OidcDiscovery = {
		issuer: 'https://directory.example',
		authorization_endpoint: 'https://directory.example/login',
		token_endpoint: 'https://directory.example/exchange',
		jwks_uri: 'https://directory.example/keys.json'
	};
	const provider: ExternalProvider = {
		id: 'directory/op',
		name: 'Directory',
		issuer: discovery.issuer,
		clientId: 'registered-client',
		hasSecret: true,
		scopes: 'openid email profile',
		enabled: false,
		autoLinkEmail: false,
		requireEmailVerified: true,
		trustEmail: false,
		jitProvisioning: false,
		updatedAt: 1000,
		advanced: {
			priority: 9,
			tokenEndpointAuthMethod: 'client_secret_post',
			profileUpdateFields: ['picture']
		}
	};
	// Synthetic public certificate text for deterministic API mocks; no real provider is contacted.
	const certificate =
		'-----BEGIN CERTIFICATE-----\nVEVTVCBDRVJUSUZJQ0FURQ==\n-----END CERTIFICATE-----';
	const samlProvider: SamlIdentityProvider = {
		id: 'identity/idp',
		hasMapping: false,
		trustBlocked: false,
		name: 'Identity',
		entityId: 'urn:test:idp',
		ssoUrl: 'https://identity.example/sso',
		certificate,
		enabled: false,
		updatedAt: '2026-11-16T00:00:00Z'
	};
	function fixture(options: { enabled?: boolean; hasMapping?: boolean; kind?: 'op' | 'idp' } = {}) {
		let currentProvider = { ...provider, updatedAt: provider.updatedAt ?? 1000 };
		let currentSaml = {
			...samlProvider,
			enabled: options.enabled ?? false,
			hasMapping: options.hasMapping ?? false
		};
		let activations = 0;
		const external: ExternalProvidersClient = {
			list: fn(async () => [currentProvider]),
			get: fn(async () => ({ ...currentProvider })),
			create: fn(async (input) => {
				currentProvider = {
					...currentProvider,
					name: input.name,
					issuer: input.issuer,
					clientId: input.client_id,
					scopes: input.scopes,
					hasSecret: !!input.client_secret,
					enabled: input.enabled ?? false,
					autoLinkEmail: input.auto_link_email,
					requireEmailVerified: input.require_email_verified,
					trustEmail: input.trust_email,
					jitProvisioning: input.jit_provisioning
				};
				return { id: provider.id };
			}),
			update: fn(async (_id, input) => {
				if (input.expected_updated_at !== currentProvider.updatedAt)
					throw new ApiError(409, 'conflict', 'Changed');
				currentProvider = {
					...currentProvider,
					name: input.name ?? currentProvider.name,
					advanced: { ...currentProvider.advanced, ...input.advanced },
					updatedAt: (currentProvider.updatedAt ?? 0) + 1,
					enabled: input.enabled ?? currentProvider.enabled
				};
				if (options.kind === 'op') {
					incoming.document.revision = `settings-${currentProvider.updatedAt}`;
					incoming.document.providerUpdatedAt = new Date(currentProvider.updatedAt).toISOString();
					incoming.document.enabled = currentProvider.enabled;
				}
				return { ...currentProvider };
			}),
			discover: fn(async (issuer) => ({ ...discovery, issuer }))
		};
		const saml: SamlIdentityProvidersClient = {
			setEnabled: fn(async (_id, input) => {
				if (input.expectedUpdatedAt !== currentSaml.updatedAt)
					throw new ApiError(409, 'conflict', 'Changed');
				currentSaml = {
					...currentSaml,
					enabled: input.enabled && currentSaml.hasMapping,
					updatedAt: new Date(Date.parse(currentSaml.updatedAt) + 1000).toISOString()
				};
				incoming.document.revision = `activation-${++activations}`;
				incoming.document.providerUpdatedAt = currentSaml.updatedAt;
				incoming.document.enabled = currentSaml.enabled;
				return { ...currentSaml };
			}),
			listIdentityProviders: fn(async () => [currentSaml]),
			getIdentityProvider: fn(async () => ({ ...currentSaml })),
			createIdentityProvider: fn(async (input) => {
				currentSaml = { ...currentSaml, name: input.name, ...input.config };
				return { id: samlProvider.id };
			}),
			updateIdentityProvider: fn(async (_id, input) => {
				currentSaml = { ...currentSaml, name: input.name, ...input.config };
				return { ...currentSaml };
			})
		};
		const resources: ConnectionCreationResources & {
			externalProviders: ExternalProvidersClient;
			samlIdentityProviders: SamlIdentityProvidersClient;
		} = {
			clients: { create: fn() },
			samlProviders: { createServiceProvider: fn() },
			externalProviders: external,
			samlIdentityProviders: saml,
			canCreate: () => true
		};
		const incoming = inboundMappingFixture(options.kind ?? 'idp', options.hasMapping ?? false);
		incoming.document.providerUpdatedAt =
			options.kind === 'op'
				? new Date(currentProvider.updatedAt).toISOString()
				: currentSaml.updatedAt;
		incoming.document.enabled =
			options.kind === 'op' ? currentProvider.enabled : currentSaml.enabled;
		const saveIncoming = incoming.client.save;
		incoming.client.save = async (...args) => {
			const result = await saveIncoming(...args);
			if (options.kind === 'op')
				currentProvider = { ...currentProvider, updatedAt: Date.parse(result.providerUpdatedAt) };
			else
				currentSaml = {
					...currentSaml,
					hasMapping: result.configured,
					updatedAt: result.providerUpdatedAt
				};
			return result;
		};
		return { resources, external, saml, incoming };
	}
	const lifecycle = fixture();
	const lifecycleControl: { release?: (provider: SamlIdentityProvider) => void } = {};
	const lifecycleRead = fn(async (id: string): Promise<SamlIdentityProvider> => {
		if (id === 'identity/pending')
			return new Promise((resolve) => {
				lifecycleControl.release = resolve;
			});
		return {
			...samlProvider,
			id,
			name: id === 'identity/latest' ? 'Latest identity' : 'Initial identity'
		};
	});
	lifecycle.saml.getIdentityProvider = lifecycleRead;
	const op = fixture();
	const idp = fixture();
	const edit = fixture({ kind: 'op', hasMapping: true });
	const permissions = fixture();
	const listed = fixture();
	const readOnly = fixture();
	const navigate = fn();
	const idpContainment = fixture({ enabled: true });
	const idpActivation = fixture({ hasMapping: true });
	const inboundSaved = fixture();
	const inboundReadonly = fixture({ hasMapping: true });
	const inboundConflict = fixture({ hasMapping: true });
	const inboundError = fixture({ hasMapping: true });
	const inboundPending = fixture({ hasMapping: true });
	const saveControl: { release?: () => void } = {};
	const pendingSave = inboundPending.incoming.client.save;
	inboundPending.incoming.client.save = async (...args) => {
		await new Promise<void>((resolve) => {
			saveControl.release = resolve;
		});
		return pendingSave(...args);
	};
	inboundConflict.incoming.client.save = async () => {
		throw new ApiError(409, 'conflict', 'Changed');
	};
	inboundError.incoming.client.save = async () => {
		throw new Error('Temporary failure');
	};

	async function openIncoming(canvas: Canvas) {
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-sets')}`) })
		);
		await canvas.findByRole('button', { name: /^email/ });
	}
	async function addTrim(canvas: Canvas) {
		const target = canvas.getByRole('button', { name: /^email/ });
		if (target.getAttribute('aria-expanded') !== 'true') await userEvent.click(target);
		await userEvent.click(canvas.getByRole('button', { name: t('map.addStep') }));
		const picker = within(await canvas.findByRole('dialog', { name: t('map.pickStep') }));
		await expect(
			picker.queryByRole('button', { name: new RegExp(`^${t('map.t.persistent_identifier')}`) })
		).toBeNull();
		await userEvent.click(picker.getByRole('button', { name: new RegExp(`^${t('map.t.trim')}`) }));
		await userEvent.click(await picker.findByRole('button', { name: t('map.pick.add') }));
	}
	type Canvas = ReturnType<typeof within>;
	async function chooseInbound(canvas: Canvas, kind: 'op' | 'idp') {
		await expect(
			canvas.getByRole('radio', { name: new RegExp(`^${t('sf.wizard.out.label')}`) })
		).toBeVisible();
		await expect(
			canvas.getByRole('radio', { name: new RegExp(`^${t('sf.wizard.in.label')}`) })
		).toBeVisible();
		await expect(canvas.queryByText(t('af.wizard.sync.label'))).toBeNull();
		await userEvent.click(
			canvas.getByRole('radio', { name: new RegExp(`^${t('sf.wizard.in.label')}`) })
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await expect(canvas.getAllByRole('radio')).toHaveLength(2);
		await userEvent.click(
			canvas.getByRole('radio', { name: new RegExp(`^${t(`sf.wizard.kind.${kind}.label`)}`) })
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
	}
</script>

<Story
	name="OIDC discovery error retry and issuer change then create and reopen"
	args={{ resources: op.resources, onnavigate: navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const discover = fn(op.external.discover);
		op.external.discover = discover;
		discover.mockRejectedValueOnce(new Error('Discovery refused'));
		await chooseInbound(canvas, 'op');
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), 'Directory');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.in.issuer') }),
			discovery.issuer
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.in.readConfig') }));
		await canvas.findByText('Discovery refused');
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeDisabled();
		let release: ((value: OidcDiscovery) => void) | undefined;
		discover.mockImplementationOnce(
			() =>
				new Promise<OidcDiscovery>((resolve) => {
					release = resolve;
				})
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.in.readConfig') }));
		await userEvent.clear(canvas.getByRole('textbox', { name: t('sf.in.issuer') }));
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.in.issuer') }),
			'https://changed.example'
		);
		release?.(discovery);
		await expect(canvas.queryByText(discovery.authorization_endpoint)).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.in.readConfig') }));
		await canvas.findByText(discovery.authorization_endpoint);
		await expect(discover).toHaveBeenCalledTimes(3);
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.row.clientId') }),
			'registered-client'
		);
		await userEvent.type(
			canvas.getByLabelText(new RegExp(t('sf.in.clientSecret')), { selector: 'input' }),
			'entered-secret'
		);
		const create = fn(op.external.create);
		op.external.create = create;
		create.mockRejectedValueOnce(new StepUpCancelledError());
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await canvas.findByText(t('settings.stepUpCancelled'));
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue('Directory');
		await expect(
			canvas.getByLabelText(new RegExp(t('sf.in.clientSecret')), { selector: 'input' })
		).toHaveValue('entered-secret');
		await expect(op.external.get).not.toHaveBeenCalled();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await waitFor(() =>
			expect(op.external.create).toHaveBeenCalledWith({
				provider_type: 'oidc',
				name: 'Directory',
				issuer: 'https://changed.example',
				client_id: 'registered-client',
				client_secret: 'entered-secret',
				scopes: 'openid email profile',
				enabled: false,
				auto_link_email: false,
				require_email_verified: true,
				trust_email: false,
				jit_provisioning: false,
				authorization_endpoint: discovery.authorization_endpoint,
				token_endpoint: discovery.token_endpoint,
				jwks_uri: discovery.jwks_uri,
				userinfo_endpoint: ''
			})
		);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('/admin/applications/all/op/directory%2Fop')
		);
		await waitFor(() => expect(op.external.get).toHaveBeenCalledWith(provider.id));
		await canvas.findByRole('heading', { name: 'Directory', level: 1 });
		await waitFor(() => expect(canvas.getByText(t('secret.stored'))).toBeVisible());
		await expect(canvas.getByRole('textbox', { name: t('sf.in.issuer') })).toHaveValue(
			'https://changed.example'
		);
		await expect(canvas.queryByDisplayValue('entered-secret')).toBeNull();
		await expect(canvas.queryByText('entered-secret')).toBeNull();
	}}
/>

<Story
	name="SAML IdP requires certificate then saves disabled and reopens actual fields"
	args={{ resources: idp.resources }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await chooseInbound(canvas, 'idp');
		await expect(canvas.queryByRole('button', { name: t('sf.import.read') })).toBeNull();
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), 'Identity');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.row.entityId') }),
			samlProvider.entityId
		);
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.ours.ssoUrl') }),
			samlProvider.ssoUrl
		);
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeDisabled();
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.ours.signingCert') }),
			certificate
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await waitFor(() =>
			expect(idp.saml.createIdentityProvider).toHaveBeenCalledWith({
				name: 'Identity',
				providerType: 'saml_idp',
				enabled: false,
				config: {
					entityId: samlProvider.entityId,
					ssoUrl: samlProvider.ssoUrl,
					certificate,
					jitEmailLinkingPolicy: 'disabled',
					allowSyntheticEmailFallback: false
				}
			})
		);
		await waitFor(() => expect(idp.saml.getIdentityProvider).toHaveBeenCalledWith(samlProvider.id));
		await canvas.findByRole('heading', { name: 'Identity', level: 1 });
		await expect(canvas.getByRole('textbox', { name: t('sf.ours.signingCert') })).toHaveValue(
			certificate
		);
		await waitFor(() =>
			expect(canvas.getByText(t('sf.live.disabled'), { selector: '.badge' })).toBeVisible()
		);
		await expect(canvas.queryByRole('button', { name: t('sf.test.run') })).toBeNull();
		await userEvent.clear(canvas.getByRole('textbox', { name: t('sf.row.name') }));
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.row.name') }),
			'Changed identity'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() =>
			expect(idp.saml.updateIdentityProvider).toHaveBeenCalledWith(samlProvider.id, {
				name: 'Changed identity',
				expectedUpdatedAt: samlProvider.updatedAt,
				config: {}
			})
		);
	}}
/>

<Story
	name="OIDC save error retains replacement secret and retry omits any secret echo"
	args={{
		resources: edit.resources,
		inboundMapping: edit.incoming.client,
		initial: { kind: 'op', id: provider.id }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const update = fn(edit.external.update);
		edit.external.update = update;
		update.mockRejectedValueOnce(new Error('Server echoed replacement-secret'));
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await userEvent.clear(canvas.getByRole('textbox', { name: t('sf.row.name') }));
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.row.name') }),
			'Changed directory'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('secret.replace') }));
		const secret = canvas.getByLabelText(new RegExp(t('sf.in.clientSecret')), {
			selector: 'input'
		});
		await userEvent.type(secret, 'replacement-secret');
		await userEvent.click(canvas.getByRole('switch', { name: t('sf.live.enabled') }));
		await expect(canvas.getByText(t('sf.live.disabled'), { selector: '.badge' })).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('common.saveFailed'));
		await expect(canvas.queryByText('Server echoed replacement-secret')).toBeNull();
		await expect(secret).toHaveAttribute('type', 'password');
		await expect(secret).toHaveValue('replacement-secret');
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Changed directory'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
		await expect(update.mock.calls[1]).toEqual([
			provider.id,
			{
				name: 'Changed directory',
				client_secret: 'replacement-secret',
				enabled: true,
				expected_updated_at: provider.updatedAt
			}
		]);
		await canvas.findByText(t('sf.live.saved'));
		await expect(canvas.getByText(t('sf.live.enabled'), { selector: '.badge' })).toBeVisible();
		await expect(canvas.queryByDisplayValue('replacement-secret')).toBeNull();
		await openIncoming(canvas);
		await addTrim(canvas);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('cm.saved'));
		const mappingUpdatedAt = Date.parse(edit.incoming.document.providerUpdatedAt);
		await userEvent.click(canvas.getAllByRole('button', { name: t('af.general') })[0]);
		await userEvent.clear(canvas.getByRole('textbox', { name: t('sf.row.name') }));
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.row.name') }),
			'Mapped directory'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() =>
			expect(update).toHaveBeenLastCalledWith(provider.id, {
				name: 'Mapped directory',
				expected_updated_at: mappingUpdatedAt
			})
		);
		await canvas.findByText(t('sf.live.saved'));
	}}
/>

<Story
	name="Upstream permissions filter kinds without hiding directions in Disclosure"
	args={{
		resources: { ...permissions.resources, canCreate: (kind: ConnectionKind) => kind === 'idp' }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.queryByRole('radio', { name: new RegExp(`^${t('sf.wizard.out.label')}`) })
		).toBeNull();
		await userEvent.click(
			canvas.getByRole('radio', { name: new RegExp(`^${t('sf.wizard.in.label')}`) })
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await expect(canvas.getAllByRole('radio')).toHaveLength(1);
		await expect(
			canvas.getByRole('radio', { name: new RegExp(`^${t('sf.wizard.kind.idp.label')}`) })
		).toBeVisible();
	}}
/>

<Story
	name="Live list includes upstream OIDC and SAML identity providers"
	args={{
		resources: {
			...listed.resources,
			canList: (kind: ConnectionKind) => kind === 'op' || kind === 'idp'
		},
		list: true
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const table = await canvas.findByRole('table', { name: t('cm.connections') });
		await waitFor(() => {
			expect(within(table).getByText('OIDC OP')).toBeVisible();
			expect(within(table).getByText('SAML IdP')).toBeVisible();
			expect(
				within(table).getByRole('button', { name: t('sf.mock.open', { name: provider.name }) })
			).toBeVisible();
			expect(
				within(table).getByRole('button', { name: t('sf.mock.open', { name: samlProvider.name }) })
			).toBeVisible();
		});
		await expect(listed.external.list).toHaveBeenCalled();
		await expect(listed.saml.listIdentityProviders).toHaveBeenCalled();
	}}
/>

<Story
	name="Read permission allows reopen without edit controls"
	args={{ resources: readOnly.resources, initial: { kind: 'op', id: provider.id }, canEdit: false }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByRole('textbox', { name: t('sf.row.name') })).toBeDisabled();
		await expect(canvas.queryByRole('button', { name: t('common.save') })).toBeNull();
		await expect(canvas.getByRole('button', { name: t('secret.replace') })).toBeDisabled();
		await expect(readOnly.external.update).not.toHaveBeenCalled();
	}}
/>

<Story
	name="IdP missing mapping stays disabled until its Mapping node is bound"
	args={{ resources: fixture().resources, initial: { kind: 'idp', id: samlProvider.id } }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.live.mappingRequired'));
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
		await expect(canvas.queryByRole('combobox', { name: t('sf.row.mappingSet') })).toBeNull();
		await waitFor(() =>
			expect(
				canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-sets')}`) })
			).toBeVisible()
		);
		await waitFor(() =>
			expect(canvas.getByText(t('sf.live.disabled'), { selector: '.badge' })).toBeVisible()
		);
	}}
/>
<Story
	name="IdP disable uses minimal action while retaining invalid certificate draft"
	args={{ resources: idpContainment.resources, initial: { kind: 'idp', id: samlProvider.id } }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const cert = await canvas.findByRole('textbox', { name: t('sf.ours.signingCert') });
		await userEvent.clear(cert);
		await expect(canvas.getByRole('button', { name: t('common.save') })).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.disable') }));
		await waitFor(() =>
			expect(canvas.getByText(t('sf.live.disabled'), { selector: '.badge' })).toBeVisible()
		);
		await expect(cert).toHaveValue('');
		await expect(idpContainment.saml.setEnabled).toHaveBeenCalledWith(samlProvider.id, {
			enabled: false,
			expectedUpdatedAt: samlProvider.updatedAt
		});
		await expect(idpContainment.saml.updateIdentityProvider).not.toHaveBeenCalled();
	}}
/>
<Story
	name="IdP existing mapping permits saved-only enable"
	args={{
		resources: idpActivation.resources,
		inboundMapping: idpActivation.incoming.client,
		initial: { kind: 'idp', id: samlProvider.id }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.enable') }));
		await waitFor(() =>
			expect(canvas.getByText(t('sf.live.enabled'), { selector: '.badge' })).toBeVisible()
		);
		await expect(idpActivation.saml.setEnabled).toHaveBeenCalledWith(samlProvider.id, {
			enabled: true,
			expectedUpdatedAt: samlProvider.updatedAt
		});
	}}
/>

<Story
	name="Resource changes reload once and discard late responses without tracking render revisions"
	args={{
		resources: lifecycle.resources,
		initial: { kind: 'idp', id: samlProvider.id },
		switchSources: true
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Initial identity' });
		await expect(lifecycleRead).toHaveBeenCalledTimes(1);
		await expect(lifecycleRead).toHaveBeenCalledWith(samlProvider.id);
		const name = canvas.getByRole('textbox', { name: t('sf.row.name') });
		await userEvent.clear(name);
		await userEvent.type(name, 'Local draft renders');
		await expect(lifecycleRead).toHaveBeenCalledTimes(1);
		await userEvent.click(canvas.getByRole('button', { name: 'Open pending IdP' }));
		await waitFor(() => expect(lifecycleRead).toHaveBeenCalledTimes(2));
		await userEvent.click(canvas.getByRole('button', { name: 'Open latest IdP' }));
		await canvas.findByRole('heading', { name: 'Latest identity' });
		await expect(lifecycleRead).toHaveBeenNthCalledWith(3, 'identity/latest');
		if (!lifecycleControl.release) throw new Error('Pending source did not start loading');
		lifecycleControl.release({ ...samlProvider, name: 'Stale identity' });
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), ' draft');
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Latest identity draft'
		);
		await expect(canvas.queryByRole('heading', { name: 'Stale identity' })).toBeNull();
		await expect(lifecycleRead).toHaveBeenCalledTimes(3);
		await userEvent.click(canvas.getByRole('button', { name: 'Open OIDC source' }));
		await canvas.findByRole('heading', { name: provider.name });
		await expect(lifecycle.external.get).toHaveBeenCalledTimes(1);
		await expect(lifecycle.external.get).toHaveBeenCalledWith(provider.id);
		await expect(lifecycleRead).toHaveBeenCalledTimes(3);
	}}
/>
<Story
	name="Incoming Mapping uses fresh revisions after IdP enable and disable"
	args={{
		resources: inboundSaved.resources,
		inboundMapping: inboundSaved.incoming.client,
		initial: { kind: 'idp', id: samlProvider.id }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await userEvent.type(name, ' draft');
		await openIncoming(canvas);
		await expect(canvas.queryByRole('textbox', { name: t('sf.row.name') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: /^email/ }));
		const source = await within(canvasElement.ownerDocument.body).findByRole('option', {
			name: /^mail/
		});
		await userEvent.click(source);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('cm.saved'));
		await userEvent.click(canvas.getAllByRole('button', { name: t('af.general') })[0]);
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Identity draft'
		);
		await userEvent.clear(canvas.getByRole('textbox', { name: t('sf.row.name') }));
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), 'Identity');
		const boundUpdatedAt = inboundSaved.incoming.document.providerUpdatedAt;
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.enable') }));
		await expect(inboundSaved.saml.setEnabled).toHaveBeenCalledWith(samlProvider.id, {
			enabled: true,
			expectedUpdatedAt: boundUpdatedAt
		});
		await waitFor(() =>
			expect(canvas.getByText(t('sf.live.enabled'), { selector: '.badge' })).toBeVisible()
		);
		await openIncoming(canvas);
		await addTrim(canvas);
		await userEvent.click(canvas.getByText(t('cm.in.preview'), { selector: '.disclosure__title' }));
		await userEvent.click(canvas.getByRole('button', { name: t('cm.in.evaluate') }));
		await waitFor(() => expect(canvas.getByText(/"email": "sample@example.test"/)).toBeVisible());
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(inboundSaved.incoming.writes).toBe(2));
		await canvas.findByText(t('cm.saved'));
		await userEvent.click(canvas.getAllByRole('button', { name: t('af.general') })[0]);
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), ' draft');
		const enabledUpdatedAt = inboundSaved.incoming.document.providerUpdatedAt;
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.disable') }));
		await expect(inboundSaved.saml.setEnabled).toHaveBeenLastCalledWith(samlProvider.id, {
			enabled: false,
			expectedUpdatedAt: enabledUpdatedAt
		});
		await waitFor(() =>
			expect(canvas.getByText(t('sf.live.disabled'), { selector: '.badge' })).toBeVisible()
		);
		await openIncoming(canvas);
		await addTrim(canvas);
		await userEvent.click(canvas.getByRole('button', { name: t('cm.in.evaluate') }));
		await waitFor(() => expect(canvas.getByText(/"email": "sample@example.test"/)).toBeVisible());
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(inboundSaved.incoming.writes).toBe(3));
		await canvas.findByText(t('cm.saved'));
		await userEvent.click(canvas.getAllByRole('button', { name: t('af.general') })[0]);
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Identity draft'
		);
	}}
/>
<Story
	name="Incoming Mapping read-only inspect and preview"
	args={{
		resources: inboundReadonly.resources,
		inboundMapping: inboundReadonly.incoming.client,
		initial: { kind: 'idp', id: samlProvider.id },
		canEdit: false
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openIncoming(canvas);
		await expect(canvas.queryByRole('button', { name: t('common.save') })).toBeNull();
		await userEvent.click(canvas.getByText(t('cm.in.preview'), { selector: '.disclosure__title' }));
		await userEvent.click(canvas.getByRole('button', { name: t('cm.in.evaluate') }));
		await waitFor(() => expect(canvas.getByText(/"email": "sample@example.test"/)).toBeVisible());
	}}
/>
<Story
	name="Incoming Mapping pending disables conflicting General writes and preserves draft"
	args={{
		resources: inboundPending.resources,
		inboundMapping: inboundPending.incoming.client,
		initial: { kind: 'idp', id: samlProvider.id }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openIncoming(canvas);
		await addTrim(canvas);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(saveControl.release).toBeDefined());
		await userEvent.click(canvas.getAllByRole('button', { name: t('af.general') })[0]);
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toBeDisabled();
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
		saveControl.release?.();
		await waitFor(() =>
			expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toBeEnabled()
		);
	}}
/>
<Story
	name="Incoming Mapping conflict keeps edits"
	args={{
		resources: inboundConflict.resources,
		inboundMapping: inboundConflict.incoming.client,
		initial: { kind: 'idp', id: samlProvider.id }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openIncoming(canvas);
		await addTrim(canvas);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('cm.conflict'));
		await expect(canvas.getByRole('button', { name: t('cm.reload') })).toBeVisible();
	}}
/>
<Story
	name="Incoming Mapping save error keeps edits"
	args={{
		resources: inboundError.resources,
		inboundMapping: inboundError.incoming.client,
		initial: { kind: 'idp', id: samlProvider.id }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openIncoming(canvas);
		await addTrim(canvas);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('mc.actionFailed'));
		await expect(canvas.getByRole('button', { name: t('common.save') })).toBeEnabled();
	}}
/>
