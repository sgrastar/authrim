<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
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
</script>

<Story
	name="Default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		// Endpoints are named by what they are for, by protocol, and can be copied.
		await canvas.findByRole('heading', { name: t('tg.ep.group.saml') });
		await canvas.findByText(t('tg.ep.saml.idp_metadata'));
		await canvas.findByRole('button', { name: t('tg.copy', { name: t('tg.ep.oidc.token') }) });
		// Nothing here is a setting: no fields, and no logo.
		await expect(canvas.queryAllByRole('textbox')).toHaveLength(0);
		// The audit and data-residency profiles are the last box.
		const headings = canvas.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
		await expect(headings.at(-1)).toBe(t('tg.profiles.title'));
		await canvas.findByText(t('tg.profile.inherited'));
	}}
>
	{#snippet template()}
		<TenantGeneral info={createFakeTenantInfo()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Links open in a new tab"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		// What a browser can open is a link in a new tab, safe from the page that opened it.
		const issuer = canvas.getAllByRole('link', {
			name: /^https:\/\/acme\.auth\.example\.com\b(?!\/)/
		})[0];
		await expect(issuer).toHaveAttribute('target', '_blank');
		await expect(issuer).toHaveAttribute('rel', 'noopener noreferrer');
		await expect(issuer).toHaveAttribute('href', 'https://acme.auth.example.com');
		const jwks = canvas.getByRole('link', { name: /\.well-known\/jwks\.json/ });
		await expect(jwks).toHaveAttribute('target', '_blank');
		await expect(canvas.getByRole('link', { name: /saml\/idp\/metadata/ })).toBeInTheDocument();
		// What needs a token, a body or a parameter is only copied.
		await expect(canvas.queryByRole('link', { name: /\/token\b/ })).toBeNull();
		await expect(canvas.queryByRole('link', { name: /api\/admin\/users\b/ })).toBeNull();
		await expect(canvas.queryByRole('link', { name: /webfinger/ })).toBeNull();
		// Every one of them can be copied, links included.
		await canvas.findByRole('button', {
			name: t('tg.copy', { name: t('tg.ep.well_known.jwks') })
		});
	}}
>
	{#snippet template()}
		<TenantGeneral info={createFakeTenantInfo()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="One tenant"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		// Addresses that do not exist are said so, not left blank.
		await canvas.findAllByText(t('tg.url.none'));
	}}
>
	{#snippet template()}
		<TenantGeneral info={createFakeTenantInfo({ singleTenant: true })} tenantId={TENANT} />
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
		<TenantGeneral info={createFakeTenantInfo({ profilesUnreadable: true })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="No access to the info"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('tg.forbidden'));
	}}
>
	{#snippet template()}
		<TenantGeneral info={createFakeTenantInfo({ fail: 403 })} tenantId={TENANT} />
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
		<TenantGeneral info={createFakeTenantInfo({ fail: 503 })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Tenant not found"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('tg.notFound'));
	}}
>
	{#snippet template()}
		<TenantGeneral info={createFakeTenantInfo({ fail: 404 })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<TenantGeneral info={createFakeTenantInfo({ delay: 60_000 })} tenantId={TENANT} />
	{/snippet}
</Story>
