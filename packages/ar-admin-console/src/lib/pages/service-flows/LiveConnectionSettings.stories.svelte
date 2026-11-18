<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { accessFromSession, hasPermission } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import {
		liveClientSettingsFixture,
		type LiveClientFixtureOptions
	} from './live-client-settings.fixture';
	import type {
		SamlServiceProvider,
		SamlProviderStatus,
		ServiceProviderBasicUpdate
	} from '#lib/api/saml-providers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { SvelteSet } from 'svelte/reactivity';
	import LiveConnectionSettingsHarness from './LiveConnectionSettingsHarness.svelte';

	const resets = new SvelteSet<() => void>();
	const { Story } = defineMeta({
		title: 'Pages/Service flows/Live basic settings',
		component: LiveConnectionSettingsHarness,
		parameters: { layout: 'fullscreen' },
		beforeEach: () => {
			for (const reset of resets) reset();
			back.mockClear();
		}
	});
	function fixture(options: LiveClientFixtureOptions & { mapping?: boolean } = {}) {
		const rp = liveClientSettingsFixture(options);
		let sp: SamlServiceProvider = {
			id: 'portal',
			name: 'Staff portal',
			entityId: 'https://portal.example.test/saml',
			acsUrl: 'https://portal.example.test/acs',
			enabled: options.enabled ?? false,
			updatedAt: '2026-11-16T00:00:00.000Z',
			hasMapping: options.mapping ?? true,
			trustBlocked: false,
			...(options.advanced
				? {
						config: {
							assertionValiditySeconds: 480,
							authnContextClassRefMode: 'assurance',
							signResponses: false,
							signAssertions: true,
							extension: 'preserve'
						}
					}
				: {})
		};
		let version = 0;
		const nextVersion = () => `2026-11-17T00:00:0${++version}.000Z`;
		const clients = {
			setEnabled: fn(rp.client.setEnabled),
			get: fn(rp.client.get),
			updateBasics: fn(rp.client.updateBasics)
		};
		async function writeServiceProvider(_id: string, input: ServiceProviderBasicUpdate) {
			if (input.expectedUpdatedAt !== sp.updatedAt) throw new ApiError(409, 'conflict', 'Conflict');
			sp = {
				...sp,
				name: input.name ?? sp.name,
				entityId: input.config?.entityId ?? sp.entityId,
				acsUrl: input.config?.acsUrl ?? sp.acsUrl,
				config: { ...sp.config, ...input.config },
				updatedAt: nextVersion()
			};
			return { ...sp };
		}

		const saml = {
			getServiceProvider: fn(async () => ({ ...sp })),
			updateServiceProvider: fn(writeServiceProvider),
			setEnabled: fn(
				async (
					_id: string,
					input: { enabled: boolean; expectedUpdatedAt: string }
				): Promise<SamlProviderStatus> => {
					if (input.expectedUpdatedAt !== sp.updatedAt)
						throw new ApiError(409, 'conflict', 'Conflict');
					sp = { ...sp, enabled: input.enabled && sp.hasMapping, updatedAt: nextVersion() };
					return { ...sp };
				}
			)
		};
		const onbind = fn(() => {
			sp = { ...sp, hasMapping: true, updatedAt: nextVersion() };
		});
		const initialSp = structuredClone(sp);
		resets.add(() => {
			rp.reset();
			sp = structuredClone(initialSp);
			version = 0;
			clients.get.mockReset().mockImplementation(rp.client.get);
			clients.setEnabled.mockReset().mockImplementation(rp.client.setEnabled);
			clients.updateBasics.mockReset().mockImplementation(rp.client.updateBasics);
			saml.getServiceProvider.mockReset();
			saml.updateServiceProvider.mockReset();
			saml.setEnabled.mockReset();
			onbind.mockReset();
		});
		return { clients, saml, onbind, writeServiceProvider, currentSp: () => ({ ...sp }) };
	}
	const rpCancelled = fixture({ activationCancelled: true });
	const rpDisabled = fixture({ enabled: true });
	const rp = fixture();
	const callbacksMissing = fixture({ redirects: [] });
	const missingConfiguration = fixture({ redirects: [] });
	const callbacksCleared = fixture();
	const ciba = fixture({ enabled: true, redirects: [], ciba: true });
	const activeCallbacksCleared = fixture({ enabled: true, refuseMissingCallbacks: true });
	const privateKey = fixture({ auth: 'private_key_jwt' });
	const legacyPublic = fixture({ enabled: true, auth: 'none', pkce: false });
	const legacyKey = fixture({ enabled: true, auth: 'private_key_jwt', missingKeys: true });
	const advanced = fixture({ advanced: true });
	const advancedSp = fixture({ advanced: true });
	const transition = fixture();
	const publicClient = fixture({ auth: 'none' });
	const sp = fixture();
	const bind = fixture({ mapping: false });
	const containment = fixture({ enabled: true, mapping: false });
	const rejected = fixture();
	const readonly = fixture();
	const updateOnly = fixture();
	const updateOnlyAccess = accessFromSession({
		permissions: [
			'admin:clients:read',
			'admin:clients:update',
			'admin:settings:read',
			'admin:settings:write'
		]
	});
	const concurrent = fixture({ mapping: false });
	const back = fn();
	type Canvas = ReturnType<typeof within>;
	async function rename(canvas: Canvas, value: string) {
		const field = await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await userEvent.clear(field);
		await userEvent.type(field, value);
	}
	async function authPanel(root: HTMLElement) {
		const heading = within(root).getByText(t('sf.part.rp-signin'), {
			selector: '.disclosure__title'
		});
		const details = heading.closest('details');
		if (!details) throw new Error('Expected authentication disclosure');
		await userEvent.click(heading);
		await waitFor(() => expect(details).toHaveAttribute('open'));
		await waitFor(() => expect(details.getAnimations({ subtree: true })).toHaveLength(0));
	}
	async function openMapping(canvas: Canvas) {
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-sets')}`) })
		);
		await waitFor(() =>
			expect(
				canvas.getByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
			).toBeVisible()
		);
	}
	async function openGeneral(canvas: Canvas) {
		await userEvent.click(canvas.getAllByRole('button', { name: t('af.general') })[0]);
		await waitFor(() => {
			expect(
				canvas.queryByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
			).toBeNull();
			expect(canvas.getByRole('heading', { name: t('af.general') })).toBeVisible();
		});
	}

	async function noPrototype(canvas: Canvas) {
		await expect(canvas.queryByRole('button', { name: t('sf.test.run') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('sf.import.read') })).toBeNull();
		await expect(canvas.queryByText('https://acme.authrim.example/saml/idp')).toBeNull();
	}
</script>

<Story
	name="RP actual values save and reload with secret reuse"
	args={{ ...rp, onback: back }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Renamed portal');
		await authPanel(canvasElement);
		await expect(canvas.queryByRole('combobox', { name: t('sf.row.appType') })).toBeNull();
		const auth = canvas.getByRole('combobox', { name: t('sf.rp.authLabel') });
		await expect(within(auth).getByRole('option', { name: t('sf.rp.auth.jwt') })).toBeEnabled();
		await userEvent.selectOptions(auth, 'client_secret_post');
		const redirect = canvas.getByRole('textbox', {
			name: t('list.item', { label: t('sf.part.rp-redirect'), n: 1 })
		});
		await userEvent.clear(redirect);
		await userEvent.type(redirect, 'https://portal.example.test/new');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(rp.clients.updateBasics).toHaveBeenCalledWith('portal', {
			client_name: 'Renamed portal',
			expected_updated_at: 1000,
			redirect_uris: ['https://portal.example.test/new'],
			token_endpoint_auth_method: 'client_secret_post'
		});
		await expect(canvas.getByRole('heading', { name: 'Renamed portal', level: 1 })).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.reload') }));
		await waitFor(() => expect(rp.clients.get).toHaveBeenCalledTimes(2));
		await expect(redirect).toHaveValue('https://portal.example.test/new');
		await expect(auth).toHaveValue('client_secret_post');
		await expect(
			canvas.queryByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
		).toBeNull();
		await noPrototype(canvas);
		await rename(canvas, 'Unsaved navigation draft');
		const previousBackCalls = back.mock.calls.length;
		await userEvent.click(canvas.getByRole('button', { name: t('sf.detail.back') }));
		const leave = within(
			await within(canvasElement.ownerDocument.body).findByRole('dialog', {
				name: t('sf.unsaved.title')
			})
		);
		await userEvent.click(leave.getByRole('button', { name: t('sf.unsaved.keep') }));
		await expect(back).toHaveBeenCalledTimes(previousBackCalls);
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Unsaved navigation draft'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('common.discard') }));
	}}
/>

<Story
	name="Private key authentication and its public key URL remain editable"
	args={{ ...privateKey }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Key client renamed');
		await authPanel(canvasElement);
		await expect(canvas.getByRole('combobox', { name: t('sf.rp.authLabel') })).toHaveValue(
			'private_key_jwt'
		);
		const uri = canvas.getByRole('textbox', { name: t('cs.row.jwksUri') });
		await expect(uri).toHaveValue('https://keys.example.test/jwks');
		await userEvent.clear(uri);
		await userEvent.type(uri, 'https://rotated.example.test/jwks');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(privateKey.clients.updateBasics).toHaveBeenCalledWith('portal', {
			client_name: 'Key client renamed',
			expected_updated_at: 1000,
			jwks_uri: 'https://rotated.example.test/jwks',
			jwks: null
		});
	}}
/>

<Story
	name="Public client keeps no secret and required PKCE"
	args={{ ...publicClient }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await authPanel(canvasElement);
		await expect(canvas.queryByRole('combobox', { name: t('sf.rp.authLabel') })).toBeNull();
		const pkce = canvas.getByRole('switch', { name: t('sf.rp.requirePkce') });
		await expect(pkce).toBeChecked();
		await expect(pkce).toBeDisabled();
	}}
/>

<Story
	name="SP cancel error conflict keep draft and explicit reload confirms discard"
	args={{ kind: 'sp', ...sp }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Changed service');
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
		await waitFor(() => expect(canvas.getByText(t('sf.live.saveFirst'))).toBeVisible());
		sp.saml.updateServiceProvider.mockRejectedValueOnce(new StepUpCancelledError());
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('settings.stepUpCancelled'));
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Changed service'
		);
		sp.saml.updateServiceProvider.mockRejectedValueOnce(new Error('Refused'));
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('common.saveFailed'));
		sp.saml.updateServiceProvider.mockRejectedValueOnce(new ApiError(409, 'conflict', 'Changed'));
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.conflict'));
		await expect(sp.saml.getServiceProvider).toHaveBeenCalledTimes(1);
		await userEvent.click(canvas.getAllByRole('button', { name: t('sf.live.reload') })[0]);
		const dialog = within(
			await within(canvasElement.ownerDocument.body).findByRole('dialog', {
				name: t('sf.live.reloadTitle')
			})
		);
		await userEvent.click(dialog.getByRole('button', { name: t('sf.live.reload') }));
		await waitFor(() =>
			expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue('Staff portal')
		);
		await rename(canvas, 'Saved service');
		const acs = canvas.getByRole('textbox', { name: t('sf.ours.acsUrl') });
		await userEvent.clear(acs);
		await userEvent.type(acs, 'https://portal.example.test/new-acs');
		const entity = canvas.getByRole('textbox', { name: t('sf.row.entityId') });
		await userEvent.clear(entity);
		await userEvent.type(entity, 'urn:test:updated-sp');
		let release: (() => void) | undefined;
		sp.saml.updateServiceProvider.mockImplementationOnce(async (id, input) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return sp.writeServiceProvider(id, input);
		});
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await openMapping(canvas);
		await expect(canvas.queryByRole('textbox', { name: t('sf.ours.acsUrl') })).toBeNull();
		await openGeneral(canvas);
		await expect(acs).toBeVisible();
		await expect(acs).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await expect(sp.saml.updateServiceProvider).toHaveBeenCalledTimes(4);
		if (!release) throw new Error('Settings write did not reach the pending fixture');
		release();
		await canvas.findByText(t('sf.live.saved'));
		await expect(sp.saml.updateServiceProvider).toHaveBeenLastCalledWith('portal', {
			name: 'Saved service',
			expectedUpdatedAt: '2026-11-16T00:00:00.000Z',
			config: { entityId: 'urn:test:updated-sp', acsUrl: 'https://portal.example.test/new-acs' }
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.reload') }));
		await waitFor(() => expect(sp.saml.getServiceProvider).toHaveBeenCalledTimes(3));
		await expect(acs).toHaveValue('https://portal.example.test/new-acs');
		await expect(entity).toHaveValue('urn:test:updated-sp');
		await expect(
			canvas.queryByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
		).toBeNull();
		await noPrototype(canvas);
	}}
/>

<Story
	name="SP mapping bind then saved-only enable uses new version"
	args={{ kind: 'sp', ...bind, mappingMissing: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.live.mappingRequired'));
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
		await expect(
			canvas.queryByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
		).toBeNull();
		await openMapping(canvas);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) }),
			'set-portal'
		);
		await canvas.findByRole('button', { name: /^email/ });
		await openGeneral(canvas);
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
		await openMapping(canvas);
		await userEvent.click(canvas.getByRole('button', { name: t('cm.saveBind') }));
		await canvas.findByText(t('cm.saved'));
		await openGeneral(canvas);
		await expect(bind.onbind).toHaveBeenCalledTimes(1);
		const version = bind.currentSp().updatedAt;
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.enable') }));
		await waitFor(() =>
			expect(bind.saml.setEnabled).toHaveBeenCalledWith('portal', {
				enabled: true,
				expectedUpdatedAt: version
			})
		);
		await waitFor(() => {
			const badge = canvas.getByText(t('sf.live.enabled'), { selector: '.badge' });
			expect(badge).toBeVisible();
			expect(badge).toHaveClass('badge--success');
		});
	}}
/>

<Story
	name="Disable remains available without mapping and preserves invalid draft"
	args={{ kind: 'sp', ...containment, mappingMissing: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Unsaved service');
		const acs = canvas.getByRole('textbox', { name: t('sf.ours.acsUrl') });
		await userEvent.clear(acs);
		await expect(canvas.getByRole('button', { name: t('common.save') })).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.disable') }));
		await canvas.findByText(t('sf.live.disabled'), { selector: '.badge' });
		await expect(containment.saml.setEnabled).toHaveBeenCalledWith('portal', {
			enabled: false,
			expectedUpdatedAt: '2026-11-16T00:00:00.000Z'
		});
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Unsaved service'
		);
		await expect(acs).toHaveValue('');
		await expect(containment.saml.updateServiceProvider).not.toHaveBeenCalled();
	}}
/>

<Story
	name="Activation pending cancel rejected and disabled backend result never become optimistic success"
	args={{ kind: 'sp', ...rejected, onback: back }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		let finish: ((value: SamlProviderStatus) => void) | undefined;
		rejected.saml.setEnabled.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.enable') }));
		await waitFor(() =>
			expect(canvas.getByText(t('sf.live.disabled'), { selector: '.badge' })).toBeVisible()
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.enable') }));
		await expect(rejected.saml.setEnabled).toHaveBeenCalledTimes(1);
		finish?.({ ...rejected.currentSp(), enabled: false });
		await canvas.findByText(t('sf.live.activationRejected'));
		rejected.saml.setEnabled.mockRejectedValueOnce(new StepUpCancelledError());
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.enable') }));
		await canvas.findByText(t('settings.stepUpCancelled'));
		rejected.saml.setEnabled.mockRejectedValueOnce(new ApiError(400, 'invalid', 'Mapping refused'));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.enable') }));
		await canvas.findByText(t('sf.live.activationFailed'));
		await waitFor(() =>
			expect(canvas.getByText(t('sf.live.disabled'), { selector: '.badge' })).toBeVisible()
		);
	}}
/>

<Story
	name="Read role has actual values without write controls"
	args={{ kind: 'sp', ...readonly, canEdit: false }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('https://portal.example.test/acs');
		await expect(canvas.queryByRole('button', { name: t('common.save') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('sf.live.enable') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('cm.create') })).toBeNull();
		await expect(canvas.queryByRole('textbox', { name: t('sf.row.name') })).toBeNull();
	}}
/>

<Story
	name="Mapping bind refresh preserves a basic draft and its loaded conflict version"
	args={{ kind: 'sp', ...concurrent, mappingMissing: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Keep this draft');
		await expect(
			canvas.queryByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
		).toBeNull();
		await openMapping(canvas);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) }),
			'set-portal'
		);
		await canvas.findByRole('button', { name: /^email/ });
		await userEvent.click(canvas.getByRole('button', { name: t('cm.saveBind') }));
		await canvas.findByText(t('cm.saved'));
		await openGeneral(canvas);
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Keep this draft'
		);
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.conflict'));
		await expect(concurrent.saml.updateServiceProvider).toHaveBeenCalledWith('portal', {
			name: 'Keep this draft',
			expectedUpdatedAt: '2026-11-16T00:00:00.000Z'
		});
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Keep this draft'
		);
	}}
/>

<Story
	name="RP update-only role has no basic-save or mapping-bind controls"
	args={{ ...updateOnly, canEdit: hasPermission(updateOnlyAccess, 'admin:clients:write') }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('https://portal.example.test/callback');
		await expect(canvas.queryByRole('textbox', { name: t('sf.row.name') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('common.save') })).toBeNull();
		await openMapping(canvas);
		await expect(canvas.queryByRole('button', { name: t('cm.saveBind') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('cm.create') })).toBeNull();
		await expect(updateOnly.clients.updateBasics).not.toHaveBeenCalled();
	}}
/>

<Story
	name="Stored advanced values survive partial save discard and reopen"
	args={{ ...advanced }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		const profile = canvas.getByText(t('cs.part.rp-profile'), { selector: '.disclosure__title' });
		await userEvent.click(profile);
		const description = canvas.getByRole('textbox', { name: t('cs.row.description') });
		await waitFor(() => expect(description).toBeVisible());
		await expect(description).toHaveValue('Stored note');
		await userEvent.clear(description);
		await userEvent.type(description, 'Changed note');
		await userEvent.click(canvas.getByRole('button', { name: t('common.discard') }));
		await expect(description).toHaveValue('Stored note');
		await userEvent.clear(description);
		await userEvent.type(description, 'Saved note');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(advanced.clients.updateBasics).toHaveBeenLastCalledWith('portal', {
			expected_updated_at: 1000,
			advanced: { description: 'Saved note' }
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.reload') }));
		await waitFor(() => expect(advanced.clients.get).toHaveBeenCalledTimes(2));
		await expect(description).toHaveValue('Saved note');
		await userEvent.click(
			canvas.getByText(t('cs.part.rp-tokens'), { selector: '.disclosure__title' })
		);
		const alg = canvas.getByRole('combobox', { name: t('cs.row.idTokenAlg') });
		await waitFor(() => expect(alg).toBeVisible());
		await expect(alg).toHaveValue('PS256');
		const details = alg.closest('details');
		if (!details) throw new Error('Expected token disclosure');
		await waitFor(() => expect(details.getAnimations({ subtree: true })).toHaveLength(0));
		await noPrototype(canvas);
	}}
/>

<Story
	name="Key auth validates URI and keeps a pending or conflicting draft"
	args={{ ...transition }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await authPanel(canvasElement);
		const auth = canvas.getByRole('combobox', { name: t('sf.rp.authLabel') });
		await userEvent.selectOptions(auth, 'private_key_jwt');
		const uri = canvas.getByRole('textbox', { name: t('cs.row.jwksUri') });
		const save = canvas.getByRole('button', { name: t('common.save') });
		await expect(save).toBeEnabled();
		await userEvent.type(uri, 'http://keys.example.test/jwks');
		await expect(save).toBeDisabled();
		await userEvent.clear(uri);
		await userEvent.type(uri, 'https://keys.example.test/jwks');
		let release: (() => void) | undefined;
		transition.clients.updateBasics.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			throw new ApiError(409, 'conflict', 'Changed');
		});
		await userEvent.click(save);
		await expect(uri).toBeDisabled();
		await expect(save).toBeDisabled();
		await expect(transition.clients.updateBasics).toHaveBeenCalledTimes(1);
		if (!release) throw new Error('Expected pending update');
		release();
		await canvas.findByText(t('sf.live.conflict'));
		await expect(auth).toHaveValue('private_key_jwt');
		await expect(uri).toHaveValue('https://keys.example.test/jwks');
		await expect(transition.clients.get).toHaveBeenCalledTimes(1);
		await userEvent.click(canvas.getByRole('button', { name: t('common.discard') }));
		await expect(auth).toHaveValue('client_secret_basic');
	}}
/>

<Story
	name="SAML assertion settings reopen their stored nondefault values"
	args={{ kind: 'sp', ...advancedSp }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await userEvent.click(
			canvas.getByText(t('cs.part.assertion'), { selector: '.disclosure__title' })
		);
		const lifetime = canvas.getByRole('textbox', { name: t('cs.row.assertionLifetime') });
		await waitFor(() => expect(lifetime).toBeVisible());
		await expect(lifetime).toHaveValue('480');
		const context = canvas.getByRole('combobox', { name: t('cs.row.authnContextMode') });
		await expect(context).toHaveValue('assurance');
		await userEvent.clear(lifetime);
		await userEvent.type(lifetime, '600');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(advancedSp.saml.updateServiceProvider).toHaveBeenLastCalledWith('portal', {
			expectedUpdatedAt: '2026-11-16T00:00:00.000Z',
			config: { assertionValiditySeconds: 600 }
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.reload') }));
		await waitFor(() => expect(advancedSp.saml.getServiceProvider).toHaveBeenCalledTimes(2));
		await expect(lifetime).toHaveValue('600');
		await expect(context).toHaveValue('assurance');
	}}
/>

<Story
	name="RP with no callbacks can save its name and add a callback later"
	args={{ ...callbacksMissing }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByText(t('sf.rp.callbacksMissing'))).toBeVisible());
		await rename(canvas, 'Callback later');
		await expect(canvas.getByRole('button', { name: t('common.save') })).toBeEnabled();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(callbacksMissing.clients.updateBasics).toHaveBeenCalledWith('portal', {
			client_name: 'Callback later',
			expected_updated_at: 1000
		});
		await waitFor(() => expect(canvas.getByText(t('sf.rp.callbacksMissing'))).toBeVisible());
		await userEvent.click(canvas.getByRole('button', { name: t('sf.rp.addRedirect') }));
		await userEvent.type(
			canvas.getByRole('textbox', {
				name: t('list.item', { label: t('sf.part.rp-redirect'), n: 1 })
			}),
			'https://portal.example.test/later'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() =>
			expect(callbacksMissing.clients.updateBasics).toHaveBeenLastCalledWith('portal', {
				redirect_uris: ['https://portal.example.test/later'],
				expected_updated_at: 1001
			})
		);
		await waitFor(() => expect(canvas.queryByText(t('sf.rp.callbacksMissing'))).toBeNull());
	}}
/>

<Story
	name="RP can save and reopen an empty callback list"
	args={{ ...callbacksCleared }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await userEvent.click(
			canvas.getByRole('button', {
				name: t('list.remove', { name: 'https://portal.example.test/callback' })
			})
		);
		await expect(canvas.queryByText(t('sf.rp.callbacksMissing'))).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(callbacksCleared.clients.updateBasics).toHaveBeenCalledWith('portal', {
			redirect_uris: [],
			expected_updated_at: 1000
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.reload') }));
		await waitFor(() => expect(callbacksCleared.clients.get).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(canvas.getByText(t('sf.rp.callbacksMissing'))).toBeVisible());
	}}
/>

<Story
	name="RP activation step-up cancelled"
	args={{ ...rpCancelled }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('sf.live.enable') }));
		await expect(rpCancelled.clients.setEnabled).toHaveBeenCalledWith('portal', true, 1000);
		await waitFor(() => expect(canvas.getByText(t('settings.stepUpCancelled'))).toBeVisible());
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeEnabled();
	}}
/>
<Story
	name="RP missing configuration cannot activate"
	args={{ ...missingConfiguration }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
		await waitFor(() => expect(canvas.getByText(t('sf.rp.missing.redirect_uris'))).toBeVisible());
		await expect(missingConfiguration.clients.setEnabled).not.toHaveBeenCalled();
	}}
/>
<Story
	name="RP disable uses L1"
	args={{ ...rpDisabled }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('sf.live.disable') }));
		await expect(rpDisabled.clients.setEnabled).toHaveBeenCalledWith('portal', false, 1000);
	}}
/>

<Story
	name="Enabled CIBA client can rename without callbacks"
	args={{ ...ciba }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'CIBA polling');
		await expect(canvas.queryByText(t('sf.rp.callbacksMissing'))).toBeNull();
		await expect(canvas.getByRole('button', { name: t('common.save') })).toBeEnabled();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(ciba.clients.updateBasics).toHaveBeenCalledWith('portal', {
			client_name: 'CIBA polling',
			expected_updated_at: 1000
		});
	}}
/>
<Story
	name="Server refuses missing callbacks on an enabled browser client"
	args={{ ...activeCallbacksCleared }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await userEvent.click(
			canvas.getByRole('button', {
				name: t('list.remove', { name: 'https://portal.example.test/callback' })
			})
		);
		await expect(canvas.getByRole('button', { name: t('common.save') })).toBeEnabled();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(canvas.getByText(t('common.saveFailed'))).toBeVisible());
		await expect(activeCallbacksCleared.clients.updateBasics).toHaveBeenCalledWith('portal', {
			redirect_uris: [],
			expected_updated_at: 1000
		});
	}}
/>

<Story
	name="Enabled legacy public client can rename without PKCE"
	args={{ ...legacyPublic }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Legacy public renamed');
		await expect(canvas.getByRole('button', { name: t('common.save') })).toBeEnabled();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(legacyPublic.clients.updateBasics).toHaveBeenCalledWith('portal', {
			client_name: 'Legacy public renamed',
			expected_updated_at: 1000
		});
	}}
/>
<Story
	name="Enabled legacy private key client can rename without keys"
	args={{ ...legacyKey }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Legacy key renamed');
		await authPanel(canvasElement);
		await expect(canvas.getByRole('textbox', { name: t('cs.row.jwksUri') })).toHaveValue('');
		await expect(canvas.getByRole('button', { name: t('common.save') })).toBeEnabled();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(legacyKey.clients.updateBasics).toHaveBeenCalledWith('portal', {
			client_name: 'Legacy key renamed',
			expected_updated_at: 1000
		});
	}}
/>
