<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { CreateClientInput } from '#lib/api/clients.js';
	import type { CreateServiceProviderInput } from '#lib/api/saml-providers.js';
	import LiveAddConnection from './LiveAddConnection.svelte';
	import type { ConnectionCreationResources } from './connection-creation';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Live connection creation',
		component: LiveAddConnection,
		parameters: { layout: 'fullscreen' }
	});

	type Canvas = ReturnType<typeof within>;
	async function choose(canvas: Canvas, kind: 'rp' | 'sp') {
		await expect(canvas.queryByRole('radio', { name: /SCIM|CSV/ })).toBeNull();
		await userEvent.click(
			canvas.getByRole('radio', { name: new RegExp(`^${t('sf.wizard.out.label')}`) })
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await expect(
			canvas.getByRole('radio', { name: /^An app that uses OpenID Connect/ })
		).toBeVisible();
		await expect(canvas.getByRole('radio', { name: /^A service that uses SAML/ })).toBeVisible();
		await expect(canvas.getAllByRole('radio')).toHaveLength(2);
		await userEvent.click(
			canvas.getByRole('radio', {
				name: kind === 'rp' ? /^An app that uses OpenID Connect/ : /^A service that uses SAML/
			})
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
	}
	async function rpForm(canvas: Canvas, appType: 'web' | 'spa' | 'native') {
		await choose(canvas, 'rp');
		await expect(canvas.getByRole('button', { name: t('wizard.next') })).toBeDisabled();
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), 'Portal');
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('sf.row.appType') }),
			appType
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await expect(canvas.getByRole('button', { name: t('wizard.next') })).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.rp.addRedirect') }));
		await userEvent.type(
			canvas.getByRole('textbox'),
			appType === 'native' ? 'com.test.portal:/callback' : 'https://portal.example/callback'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		const method = canvas.getByRole('combobox', { name: t('sf.rp.authLabel') });
		await expect(method).toHaveValue(appType === 'web' ? 'client_secret_basic' : 'none');
		const jwtOption = within(method).getByRole('option', { name: t('sf.rp.auth.jwt') });
		if (appType === 'web') await expect(jwtOption).toBeEnabled();
		else await expect(jwtOption).toBeDisabled();
		if (appType !== 'web') {
			await expect(canvas.getByRole('switch')).toBeChecked();
			await expect(canvas.getByRole('switch')).toBeDisabled();
		}
	}

	const webControl: { release?: () => void } = {};
	const webCreate = fn(async (_input: CreateClientInput) => {
		await new Promise<void>((resolve) => {
			webControl.release = resolve;
		});
		return { id: 'web/client', clientSecret: 'test-only-once' };
	});
	const webNavigate = fn(async (_path: string) => {});
	const unusedSp = fn(async (_input: CreateServiceProviderInput) => ({ id: 'unused' }));
	const webResources: ConnectionCreationResources = {
		clients: { create: webCreate },
		samlProviders: { createServiceProvider: unusedSp },
		canCreate: () => true
	};

	const spCreate = fn(async (_input: CreateServiceProviderInput) => ({ id: 'service/sp' }));
	const spNavigate = fn(async (_path: string) => {});
	const spResources: ConnectionCreationResources = {
		clients: { create: fn() },
		samlProviders: { createServiceProvider: spCreate },
		canCreate: () => true
	};
	const spaCreate = fn(async (_input: CreateClientInput) => ({ id: 'spa-client' }));
	const spaNavigate = fn(async (_path: string) => {});
	const spaResources: ConnectionCreationResources = {
		clients: { create: spaCreate },
		samlProviders: { createServiceProvider: fn() },
		canCreate: () => true
	};
	const nativeCreate = fn(async (_input: CreateClientInput) => ({ id: 'native-client' }));
	const nativeNavigate = fn(async (_path: string) => {});
	const nativeResources: ConnectionCreationResources = {
		clients: { create: nativeCreate },
		samlProviders: { createServiceProvider: fn() },
		canCreate: () => true
	};
	const deferredCreate = fn(async (_input: CreateClientInput) => ({ id: 'callback-later' }));
	const deferredNavigate = fn(async (_path: string) => {});
	const deferredResources: ConnectionCreationResources = {
		clients: { create: deferredCreate },
		samlProviders: { createServiceProvider: fn() },
		canCreate: () => true
	};
</script>

<Story
	name="Web RP saves once and shows its credential before navigation"
	args={{ resources: webResources, onnavigate: webNavigate }}
	play={async ({ canvasElement }) => {
		webCreate.mockClear();
		webNavigate.mockClear();
		unusedSp.mockClear();
		const canvas = within(canvasElement);
		await rpForm(canvas, 'web');
		const save = canvas.getByRole('button', { name: t('sf.create.save') });
		await userEvent.dblClick(save);
		await waitFor(() => expect(webCreate).toHaveBeenCalledTimes(1));
		await expect(save).toBeDisabled();
		await expect(canvas.getByRole('combobox')).toBeDisabled();
		await expect(webNavigate).not.toHaveBeenCalled();
		await expect(webCreate).toHaveBeenCalledWith({
			client_name: 'Portal',
			application_type: 'web',
			redirect_uris: ['https://portal.example/callback'],
			grant_types: ['authorization_code'],
			response_types: ['code'],
			scope: 'openid',
			token_endpoint_auth_method: 'client_secret_basic',
			require_pkce: true
		});
		webControl.release?.();
		await canvas.findByText(t('secret.once'));
		await expect(canvas.queryByText('test-only-once')).toBeNull();
		await expect(webNavigate).not.toHaveBeenCalled();
		await userEvent.click(
			canvas.getByRole('button', { name: t('secret.show', { name: t('sf.in.clientSecret') }) })
		);
		await expect(canvas.getByText('test-only-once')).toBeVisible();
		await expect(canvas.getByText('web/client')).toBeVisible();
		webNavigate.mockRejectedValueOnce(new Error('Navigation failed'));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.wizard.finish') }));
		await waitFor(() =>
			expect(webNavigate).toHaveBeenCalledWith('/admin/applications/all/rp/web%2Fclient')
		);
		await canvas.findByText(t('sf.create.navigationFailed'));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.wizard.finish') }));
		await waitFor(() => expect(webNavigate).toHaveBeenCalledTimes(2));
		await expect(webCreate).toHaveBeenCalledTimes(1);
		await expect(unusedSp).not.toHaveBeenCalled();
	}}
/>

<Story
	name="Manual SP keeps answers after API error and retries into real detail"
	args={{ resources: spResources, onnavigate: spNavigate }}
	play={async ({ canvasElement }) => {
		spCreate.mockClear();
		spNavigate.mockClear();
		spCreate.mockRejectedValueOnce(new Error('Creation refused'));
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.manual') }));
		await expect(canvas.queryByRole('button', { name: t('sf.import.read') })).toBeNull();
		await expect(canvas.queryByText(t('sf.ours.signingCert'))).toBeNull();
		await expect(canvas.queryByRole('tab')).toBeNull();
		const save = canvas.getByRole('button', { name: t('sf.create.save') });
		await expect(save).toBeDisabled();
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), 'Service');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.row.entityId') }),
			'urn:test:service'
		);
		await expect(save).toBeDisabled();
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.ours.acsUrl') }),
			'https://service.example/acs'
		);
		await userEvent.click(save);
		await canvas.findByText('Creation refused');
		await expect(spNavigate).not.toHaveBeenCalled();
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue('Service');
		await expect(canvas.getByRole('textbox', { name: t('sf.row.entityId') })).toHaveValue(
			'urn:test:service'
		);
		await expect(canvas.getByRole('textbox', { name: t('sf.ours.acsUrl') })).toHaveValue(
			'https://service.example/acs'
		);
		await userEvent.click(save);
		await waitFor(() =>
			expect(spNavigate).toHaveBeenCalledWith('/admin/applications/all/sp/service%2Fsp')
		);
		await expect(spCreate).toHaveBeenCalledTimes(2);
		for (const [input] of spCreate.mock.calls) {
			await expect(input).toEqual({
				name: 'Service',
				providerType: 'saml_sp',
				enabled: false,
				config: {
					entityId: 'urn:test:service',
					acsUrl: 'https://service.example/acs',
					allowedBindings: ['post'],
					signAssertions: true,
					signResponses: true
				}
			});
		}
		await expect(canvas.queryByText(t('sf.test.metadataRead'))).toBeNull();
	}}
/>

<Story
	name="SPA uses public SPA registration and PKCE"
	args={{ resources: spaResources, onnavigate: spaNavigate }}
	play={async ({ canvasElement }) => {
		spaCreate.mockClear();
		spaNavigate.mockClear();
		const canvas = within(canvasElement);
		await rpForm(canvas, 'spa');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await waitFor(() =>
			expect(spaNavigate).toHaveBeenCalledWith('/admin/applications/all/rp/spa-client')
		);
		await expect(spaCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				application_type: 'spa',
				token_endpoint_auth_method: 'none',
				require_pkce: true,
				redirect_uris: ['https://portal.example/callback']
			})
		);
		await expect(canvas.queryByText(t('secret.once'))).toBeNull();
	}}
/>

<Story
	name="Native uses native redirect semantics and PKCE"
	args={{ resources: nativeResources, onnavigate: nativeNavigate }}
	play={async ({ canvasElement }) => {
		nativeCreate.mockClear();
		nativeNavigate.mockClear();
		const canvas = within(canvasElement);
		await rpForm(canvas, 'native');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await waitFor(() =>
			expect(nativeNavigate).toHaveBeenCalledWith('/admin/applications/all/rp/native-client')
		);
		await expect(nativeCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				application_type: 'native',
				token_endpoint_auth_method: 'none',
				require_pkce: true,
				redirect_uris: ['com.test.portal:/callback']
			})
		);
	}}
/>

<Story
	name="Creation permissions leave the account flows available"
	args={{ resources: { ...webResources, canCreate: () => false } }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.queryByText(t('sf.wizard.out.label'))).toBeNull();
		await userEvent.click(canvas.getByRole('radio'));
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await expect(canvas.getByRole('radio', { name: /^Sign-up/ })).toBeVisible();
		await expect(canvas.getByRole('radio', { name: /^Sign-in/ })).toBeVisible();
	}}
/>

<Story
	name="RP skips callbacks and stays on the completion screen until details are opened"
	args={{ resources: deferredResources, onnavigate: deferredNavigate }}
	play={async ({ canvasElement }) => {
		deferredCreate.mockClear();
		deferredNavigate.mockClear();
		const canvas = within(canvasElement);
		await choose(canvas, 'rp');
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), 'Callback later');
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('sf.row.appType') }),
			'spa'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		const next = canvas.getByRole('button', { name: t('wizard.next') });
		await expect(next).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.rp.addRedirect') }));
		await userEvent.type(canvas.getByRole('textbox'), 'unfinished');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.draft.skip') }));
		await expect(canvas.getByText(t('sf.rp.callbacksMissing'))).toBeVisible();
		await expect(next).toBeEnabled();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.draft.enterNow') }));
		await expect(next).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.draft.skip') }));
		await userEvent.click(next);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await canvas.findByRole('heading', { name: t('sf.create.saved') });
		await expect(canvas.getByText(t('sf.rp.callbacksMissing'))).toBeVisible();
		await expect(deferredCreate).toHaveBeenCalledOnce();
		await expect(deferredCreate.mock.calls[0][0]).toMatchObject({
			redirect_uris: [],
			application_type: 'spa',
			token_endpoint_auth_method: 'none',
			require_pkce: true
		});
		await expect(deferredCreate.mock.calls[0][0]).not.toHaveProperty('enabled');
		await expect(deferredNavigate).not.toHaveBeenCalled();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.draft.openDetails') }));
		await waitFor(() =>
			expect(deferredNavigate).toHaveBeenCalledWith('/admin/applications/all/rp/callback-later')
		);
	}}
/>
