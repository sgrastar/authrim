<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import { persona } from '$lib/access/personas';
	import { t } from '$lib/i18n/i18n.svelte';
	import type { SettingsPageDef } from './placement';
	import SettingsPage from './SettingsPage.svelte';

	const { Story } = defineMeta({
		title: 'Settings/Notices',
		component: SettingsPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Notices above a settings section about the consequence of a choice (`setting-notices.ts`), from the values on screen: a warning when the choice departs from a specification (one ID token algorithm other than RS256 drops RS256 from Discovery), an information note when it stays within the specifications but some apps may stop working (FAPI 2.0).'
				}
			}
		}
	});

	/** A page with the settings the notices are about (they have no built page yet). */
	const PAGE: SettingsPageDef = {
		id: 'notices',
		nav: 'settings/signing-keys',
		title: 'set.k.oauth.id_token_signing_alg',
		description: 'set.k.oauth.id_token_signing_alg.desc',
		sections: [
			{
				id: 'signing',
				title: 'set.k.oauth.id_token_signing_alg',
				settings: [
					{ key: 'oauth.id_token_signing_alg', depth: 'primary' },
					{ key: 'oauth.id_token_signing_alg_client_override', depth: 'primary' }
				]
			},
			{
				id: 'fapi',
				title: 'set.k.security.fapi_enabled',
				settings: [{ key: 'security.fapi_enabled', depth: 'primary' }]
			}
		]
	};

	const tenant = { level: 'tenant', tenantId: 'acme' } as const;
	const client = (stored: Record<string, unknown>) =>
		createFakeSettings({
			access: () => persona('tenant').access,
			stored: { 'tenant:acme': stored }
		});
</script>

<Story
	name="Both notices"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('settings.notice.idTokenAlgorithm.title'));
		expect(canvas.getByText(t('settings.notice.fapi.title'))).toBeTruthy();
	}}
>
	{#snippet template()}
		<SettingsPage
			page={PAGE}
			target={tenant}
			access={persona('tenant').access}
			client={client({
				'oauth.id_token_signing_alg': 'ES256',
				'oauth.id_token_signing_alg_client_override': false,
				'security.fapi_enabled': true
			})}
		/>
	{/snippet}
</Story>

<Story
	name="No notice"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('set.k.security.fapi_enabled'));
		expect(canvas.queryByText(t('settings.notice.idTokenAlgorithm.title'))).toBeNull();
		expect(canvas.queryByText(t('settings.notice.fapi.title'))).toBeNull();
	}}
>
	{#snippet template()}
		<SettingsPage
			page={PAGE}
			target={tenant}
			access={persona('tenant').access}
			client={client({})}
		/>
	{/snippet}
</Story>
