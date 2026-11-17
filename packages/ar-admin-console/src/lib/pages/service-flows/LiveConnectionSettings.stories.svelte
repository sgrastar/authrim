<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { accessFromSession, hasPermission } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import type { ClientDetail, ClientBasicUpdate } from '#lib/api/clients.js';
	import type {
		SamlServiceProvider,
		SamlProviderStatus,
		ServiceProviderBasicUpdate
	} from '#lib/api/saml-providers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LiveConnectionSettingsHarness from './LiveConnectionSettingsHarness.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Live basic settings',
		component: LiveConnectionSettingsHarness,
		parameters: { layout: 'fullscreen' }
	});
	function fixture(options: { auth?: string; enabled?: boolean; mapping?: boolean } = {}) {
		let rp: ClientDetail = {
			id: 'portal',
			name: 'Staff portal',
			redirectUris: ['https://portal.example.test/callback'],
			applicationType: 'web',
			authMethod: options.auth ?? 'client_secret_basic',
			pkce: true
		};
		let sp: SamlServiceProvider = {
			id: 'portal',
			name: 'Staff portal',
			entityId: 'https://portal.example.test/saml',
			acsUrl: 'https://portal.example.test/acs',
			enabled: options.enabled ?? false,
			updatedAt: '2026-11-16T00:00:00.000Z',
			hasMapping: options.mapping ?? true,
			trustBlocked: false
		};
		let version = 0;
		const nextVersion = () => `2026-11-17T00:00:0${++version}.000Z`;
		const clients = {
			get: fn(async () => ({ ...rp, redirectUris: [...rp.redirectUris] })),
			updateBasics: fn(async (_id: string, input: ClientBasicUpdate) => {
				rp = {
					...rp,
					name: input.client_name ?? rp.name,
					redirectUris: input.redirect_uris ?? rp.redirectUris,
					authMethod: input.token_endpoint_auth_method ?? rp.authMethod,
					pkce: input.require_pkce ?? rp.pkce
				};
				return { ...rp };
			})
		};
		async function writeServiceProvider(_id: string, input: ServiceProviderBasicUpdate) {
			if (input.expectedUpdatedAt !== sp.updatedAt) throw new ApiError(409, 'conflict', 'Conflict');
			sp = { ...sp, name: input.name ?? sp.name, ...input.config, updatedAt: nextVersion() };
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
		return { clients, saml, onbind, writeServiceProvider, currentSp: () => ({ ...sp }) };
	}
	const rp = fixture();
	const privateKey = fixture({ auth: 'private_key_jwt' });
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
	name="RP actual values save and reload with secret reuse only"
	args={{ ...rp, onback: back }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Renamed portal');
		await authPanel(canvasElement);
		await expect(canvas.queryByRole('combobox', { name: t('sf.row.appType') })).toBeNull();
		const auth = canvas.getByRole('combobox', { name: t('sf.rp.authLabel') });
		await expect(within(auth).queryByRole('option', { name: t('sf.rp.auth.jwt') })).toBeNull();
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
	name="Private key authentication remains read only and independent basic edit works"
	args={{ ...privateKey }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await rename(canvas, 'Key client renamed');
		await authPanel(canvasElement);
		await expect(
			canvas.getByText(t('sf.live.authReadonly', { method: 'private_key_jwt' }))
		).toBeVisible();
		await expect(canvas.queryByRole('combobox', { name: t('sf.rp.authLabel') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(privateKey.clients.updateBasics).toHaveBeenCalledWith('portal', {
			client_name: 'Key client renamed'
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
