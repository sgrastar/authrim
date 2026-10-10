<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { adminAccess } from '$lib/access/admin-access.svelte';
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import { settingText } from '$lib/settings/setting-text';
	import EnterpriseSaml from './EnterpriseSaml.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Enterprise SSO (SAML)',
		component: EnterpriseSaml,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Authentication → Enterprise SSO (SAML): whether the tenant answers SAML at all (on by default), how long the assertions it issues and the requests it handles stay valid, and the NameID format and bindings a new SAML provider starts from. Built from the Settings API `federation` settings by its placement (`ENTERPRISE_SAML` in `settings/placement.ts`). Turning SAML off refuses the SAML endpoints and metadata but keeps the registered providers. The Artifact binding settings are not on the page until that binding exists.'
				}
			}
		}
	});

	const TENANT = 'acme';
	const settings = (stored: Record<string, unknown> = {}) =>
		createFakeSettings({
			access: () => adminAccess.current,
			latency: 200,
			stored: { [`tenant:${TENANT}`]: stored }
		});
	const label = (key: string) => t(settingText(key).label);
</script>

<Story
	name="Defaults"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(label('federation.saml_enabled'));
		await canvas.findAllByText(label('federation.saml_assertion_ttl'));
		await canvas.findAllByText(label('federation.saml_nameid_format'));
		expect(canvas.queryByText(t('settings.notice.samlDisabled.title'))).toBeNull();
		// The Artifact binding is not built: its settings are not on the page.
		expect(canvas.queryByText(label('federation.saml_artifact_ttl'))).toBeNull();
	}}
>
	{#snippet template()}
		<EnterpriseSaml client={settings()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="SAML turned off"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('settings.notice.samlDisabled.title'));
		expect(canvas.queryByText(t('load.error.title'))).toBeNull();
	}}
>
	{#snippet template()}
		<EnterpriseSaml client={settings({ 'federation.saml_enabled': false })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Providers get POST sign-in by default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('settings.notice.samlPostBinding.title'));
	}}
>
	{#snippet template()}
		<EnterpriseSaml
			client={settings({
				'federation.saml_sso_binding': 'HTTP-POST',
				'federation.saml_nameid_format': 'persistent',
				'federation.saml_assertion_ttl': 120
			})}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>
