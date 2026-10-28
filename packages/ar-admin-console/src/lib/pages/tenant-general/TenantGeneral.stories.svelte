<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '$lib/access/access';
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import { createFakeTenantInfo } from '$lib/api/fake/tenant-info-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import TenantGeneral from './TenantGeneral.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/General',
		component: TenantGeneral,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → General: the tenant’s logo (a setting), and, read-only, what the tenant is called, the addresses of its screens and API, which parts of Authrim this environment runs, the audit and data-residency profiles that apply, and the endpoints it gives to apps and partners, each with a copy button. Built on `/api/admin/tenants/{id}/info` and the Settings API; the stories use in-memory APIs.'
				}
			}
		}
	});

	const TENANT = 'acme';
	// Settings are opened by role, not by permission (see `settingsLevel`).
	const EDITOR: AdminAccess = { platform: false, roles: ['admin'], permissions: [] };
	const VIEWER: AdminAccess = { platform: false, roles: ['viewer'], permissions: [] };
</script>

<Story
	name="Default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		await canvas.findAllByText('https://acme.auth.example.com');
		// The logo is a setting, saved with the page's Save bar.
		await canvas.findByRole('textbox', { name: t('set.k.tenant.logo_uri') });
		// Endpoints are named by what they are for, by protocol, and can be copied.
		await canvas.findByRole('heading', { name: t('tg.ep.group.saml') });
		await canvas.findByText(t('tg.ep.saml.idp_metadata'));
		await canvas.findByRole('button', {
			name: t('tg.copy', { name: t('tg.ep.oidc.token') })
		});
		// What the environment does not run reads as not running.
		await canvas.findByText(t('tg.profile.inherited'));
	}}
>
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo()}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="Change the logo"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const logo = await canvas.findByRole('textbox', { name: t('set.k.tenant.logo_uri') });
		// The platform has a logo of its own; the tenant overrides it before typing its own.
		await userEvent.click(
			await canvas.findByRole('checkbox', { name: new RegExp(t('settings.setHereOption')) })
		);
		await userEvent.type(logo, 'https://cdn.example.com/acme.png');
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		await waitFor(() =>
			expect(canvas.queryByRole('button', { name: t('common.save') })).toBeNull()
		);
		await expect(logo).toHaveValue('https://cdn.example.com/acme.png');
	}}
>
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo()}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		await canvas.findByText(t('settings.readOnly.title'));
		await expect(canvas.queryByRole('textbox', { name: t('set.k.tenant.logo_uri') })).toBeNull();
	}}
>
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo()}
			tenantId={TENANT}
			access={VIEWER}
		/>
	{/snippet}
</Story>

<Story
	name="One tenant, some parts off"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		// Addresses that do not exist are said so, not left blank.
		await canvas.findAllByText(t('tg.url.none'));
		await canvas.findAllByText(t('tg.part.off'));
	}}
>
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo({ singleTenant: true, without: ['vc', 'async', 'admin_ui'] })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="Profiles unreadable"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tg.profiles.error', { reason: 'residency_profile_not_found:jp' }));
		// The rest of the page still shows.
		await canvas.findByText('Acme Corporation');
	}}
>
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo({ profilesUnreadable: true })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="No access to the info"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('tg.forbidden'));
	}}
>
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo({ fail: 403 })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="Settings unreadable"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tg.unavailable'));
		await canvas.findByRole('button', { name: t('common.retry') });
	}}
>
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo({ fail: 503 })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="Tenant not found"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('tg.notFound'));
	}}
>
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo({ fail: 404 })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<TenantGeneral
			client={createFakeSettings()}
			info={createFakeTenantInfo({ delay: 60_000 })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>
