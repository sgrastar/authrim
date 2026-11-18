<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { tenantsAccess } from '#lib/access/access.js';
	import { fakeTenantDomains } from '#lib/api/fake/tenant-domains-fake.js';
	import { fakeTenants } from '#lib/api/fake/tenants-fake.js';
	import type { TenantCopyOptions, TenantInput } from '#lib/api/tenants.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import TenantCopyFields from './TenantCopyFields.svelte';
	import TenantDetailPage from './TenantDetailPage.svelte';
	import TenantDomainsCard from './TenantDomainsCard.svelte';
	import TenantListPage from './TenantListPage.svelte';
	import { defaultCopyOptions } from './tenant-model';

	const { Story } = defineMeta({
		title: 'Pages/Platform/Tenants',
		component: TenantListPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Platform → Tenants → All tenants (`/admin/platform/tenants/list`, `/api/admin/tenants`): every tenant with its name, ID, state and dates, sortable by each column and searchable. A row opens the tenant’s page; "Create tenant" (top right) asks for a name and an ID, with the code, description and storage under "Advanced settings". A tenant’s page shows what it is and, while it is being set up, how far that got; "Copy" makes a new tenant from it with what the admin ticks (settings, roles, administrators, apps, webhooks and their secrets; flows, screens, consent statements and end users are listed as "In development" and cannot be ticked yet). The page also holds the tenant’s custom domains (`/api/admin/platform/tenant-vanity-domains`): each hostname with its state and which one is primary (the tokens’ `iss`), the DNS records still to publish, and adding, making primary (confirmed: it changes the issuer), checking again (Cloudflare) or marking as verified (set up by hand, confirmed) and removing. Deleting is at the end of the page behind a confirmation and asks for step-up (`tenant.delete`). Creating and deleting need `ar_super_admin` through a global assignment; copying also `admin:tenants:lifecycle:standard`.'
				}
			}
		}
	});

	const platform = tenantsAccess({ platform: true, roles: ['ar_super_admin'], permissions: ['*'] });
	const reader = tenantsAccess({
		platform: true,
		roles: [],
		permissions: ['admin:settings:read']
	});
	const onopen = fn();
	const ondeleted = fn();
	const copies: Array<{ source: string; input: TenantInput; copy: TenantCopyOptions }> = [];
	const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	/**
	 * The checkbox whose name starts with `label`. Names include the description, and in some
	 * languages a part's label starts its secret's label ("Webhook" / "Webhook の署名…"): the
	 * part is listed first, so the first match is it.
	 */
	const box = (scope: HTMLElement, label: string) =>
		within(scope).getAllByRole('checkbox', { name: new RegExp(`^${escapeRe(label)}`) })[0];
</script>

<Story
	name="List"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		await waitFor(() => expect(canvas.getByRole('button', { name: t('tn.create') })).toBeVisible());
	}}
>
	{#snippet template()}
		<TenantListPage client={fakeTenants({ delay: 100 })} access={platform} {onopen} />
	{/snippet}
</Story>

<Story
	name="Sorted by ID, descending"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		const header = canvas.getByRole('button', { name: new RegExp(t('tn.list.col.id')) });
		await userEvent.click(header);
		await userEvent.click(header);
		const rows = canvas.getAllByRole('row');
		await expect(within(rows[1]).getByText('initech')).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<TenantListPage client={fakeTenants()} access={platform} {onopen} />
	{/snippet}
</Story>

<Story
	name="Read-only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Acme Corporation');
		await expect(canvas.queryByRole('button', { name: t('tn.create') })).toBeNull();
	}}
>
	{#snippet template()}
		<TenantListPage client={fakeTenants()} access={reader} {onopen} />
	{/snippet}
</Story>

<Story
	name="Single-tenant deployment"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tn.list.singleTenant'));
		await expect(canvas.queryByRole('button', { name: t('tn.create') })).toBeNull();
	}}
>
	{#snippet template()}
		<TenantListPage
			client={fakeTenants({ singleTenantMode: true, tenants: [] })}
			access={platform}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('tn.list.loadFailed'));
	}}
>
	{#snippet template()}
		<TenantListPage client={fakeTenants({ failOn: { list: 500 } })} access={platform} {onopen} />
	{/snippet}
</Story>

<Story
	name="Create"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('tn.create') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(t('tn.f.name'))),
			'Umbrella Labs'
		);
		await expect(within(dialog).getByLabelText(new RegExp(t('tn.f.id')))).toHaveValue(
			'umbrella-labs'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('tn.new.submit') }));
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('umbrella-labs'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<TenantListPage client={fakeTenants()} access={platform} {onopen} />
	{/snippet}
</Story>

<Story
	name="Create with an ID in use"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('tn.create') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(within(dialog).getByLabelText(new RegExp(t('tn.f.name'))), 'Acme');
		await userEvent.click(within(dialog).getByRole('button', { name: t('tn.new.submit') }));
		await within(dialog).findByText(t('tn.f.id.taken'));
	}}
>
	{#snippet template()}
		<TenantListPage client={fakeTenants()} access={platform} {onopen} />
	{/snippet}
</Story>

<Story
	name="A tenant"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Acme Corporation' });
		// The page header fades in (Page's entry reveal): read visibility once it has.
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('tn.copy.action') })).toBeVisible()
		);
		await expect(canvas.getByRole('button', { name: t('tn.delete.action') })).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<TenantDetailPage
			domains={fakeTenantDomains()}
			client={fakeTenants({ delay: 100 })}
			tenantId="acme"
			access={platform}
			listHref="#tenants"
			{onopen}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="The default tenant"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tn.delete.defaultNote'));
		await expect(canvas.queryByRole('button', { name: t('tn.delete.action') })).toBeNull();
	}}
>
	{#snippet template()}
		<TenantDetailPage
			domains={fakeTenantDomains()}
			client={fakeTenants()}
			tenantId="default"
			access={platform}
			listHref="#tenants"
			{onopen}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="A tenant being set up"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tn.d.provisioning'));
		await canvas.findByText(t('tn.prov.running'));
		await expect(canvas.queryByRole('button', { name: t('tn.copy.action') })).toBeNull();
	}}
>
	{#snippet template()}
		<TenantDetailPage
			domains={fakeTenantDomains()}
			client={fakeTenants()}
			tenantId="initech"
			access={platform}
			listHref="#tenants"
			{onopen}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Copy"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		copies.length = 0;
		await userEvent.click(await canvas.findByRole('button', { name: t('tn.copy.action') }));
		const dialog = await body.findByRole('dialog');
		await expect(within(dialog).getByLabelText(new RegExp(t('tn.f.id')))).toHaveValue('acme-copy');
		// In development: shown, not selectable.
		await expect(
			within(dialog).getByRole('checkbox', { name: new RegExp(escapeRe(t('tn.copy.flows'))) })
		).toBeDisabled();
		// A secret ticks what holds it.
		await userEvent.click(
			within(dialog).getByRole('checkbox', {
				name: new RegExp(escapeRe(t('tn.copy.clientCredentials')))
			})
		);
		await expect(box(dialog, t('tn.copy.clients'))).toBeChecked();
		await userEvent.click(within(dialog).getByRole('button', { name: t('tn.copy.submit') }));
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('acme-copy'));
		await expect(copies.at(-1)?.copy).toMatchObject({
			settings: true,
			roles: true,
			clients: true,
			client_credentials: true
		});
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<TenantDetailPage
			domains={fakeTenantDomains()}
			client={fakeTenants({ copies })}
			tenantId="acme"
			access={platform}
			listHref="#tenants"
			{onopen}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Copy SAML connections as disabled drafts"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		copies.length = 0;
		await userEvent.click(await canvas.findByRole('button', { name: t('tn.copy.action') }));
		const dialog = await body.findByRole('dialog');
		const saml = box(dialog, t('tn.copy.samlProviders'));
		await expect(saml).not.toBeChecked();
		const description = t('tn.copy.samlProviders.desc');
		await expect(description.trim()).not.toBe('');
		// The dialog starts its entrance animation at opacity 0; wait for the real text to be visible.
		await waitFor(() => expect(within(dialog).getByText(description)).toBeVisible());
		await userEvent.click(saml);
		await userEvent.click(within(dialog).getByRole('button', { name: t('tn.copy.submit') }));
		await waitFor(() =>
			expect(copies.at(-1)?.copy).toMatchObject({
				saml_providers: true,
				clients: false,
				client_credentials: false
			})
		);
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<TenantDetailPage
			domains={fakeTenantDomains()}
			client={fakeTenants({ copies })}
			tenantId="acme"
			access={platform}
			listHref="#tenants"
			{onopen}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Copy admin access and webhooks together"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('tn.copy.action') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.click(
			within(dialog).getByRole('checkbox', { name: new RegExp(escapeRe(t('tn.copy.adminAccess'))) })
		);
		await userEvent.click(box(dialog, t('tn.copy.webhooks')));
		await userEvent.click(within(dialog).getByRole('button', { name: t('tn.copy.submit') }));
		await within(dialog).findByText(t('tn.copy.separateStepUps'));
	}}
>
	{#snippet template()}
		<TenantDetailPage
			domains={fakeTenantDomains()}
			client={fakeTenants()}
			tenantId="acme"
			access={platform}
			listHref="#tenants"
			{onopen}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Delete"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('tn.delete.action') }));
		const dialog = await body.findByRole('dialog');
		await within(dialog).findByText(t('tn.delete.confirmBody', { id: 'acme-staging' }));
		await userEvent.click(within(dialog).getByRole('button', { name: t('tn.delete.action') }));
		await waitFor(() => expect(ondeleted).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<TenantDetailPage
			domains={fakeTenantDomains()}
			client={fakeTenants()}
			tenantId="acme-staging"
			access={platform}
			listHref="#tenants"
			{onopen}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Copy choices"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const secrets = canvas.getByRole('checkbox', {
			name: new RegExp(escapeRe(t('tn.copy.secretSettings')))
		});
		await userEvent.click(secrets);
		await expect(secrets).toBeChecked();
		// Turning settings off takes their secrets with them.
		await userEvent.click(box(canvasElement, t('tn.copy.settings')));
		await expect(secrets).not.toBeChecked();
		await expect(canvas.getAllByText(t('tn.copy.inDevelopment'))).toHaveLength(4);
	}}
>
	{#snippet template()}
		<div style="max-width: 520px; padding: 24px;">
			<TenantCopyFields options={defaultCopyOptions()} />
		</div>
	{/snippet}
</Story>

<Story
	name="Custom domains"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('login.acme.example');
		await expect(canvas.getByText(t('tn.dom.primary'))).toBeInTheDocument();
		await expect(canvas.getByText(t('tn.dom.status.pending'))).toBeInTheDocument();
		await expect(
			canvas.getByText(t('tn.dom.records.title', { hostname: 'id.acme.example' }))
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<div style="max-width: 880px; padding: 24px;">
			<TenantDomainsCard client={fakeTenantDomains({ delay: 100 })} tenantId="acme" canEdit />
		</div>
	{/snippet}
</Story>

<Story
	name="Custom domains: add"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('tn.dom.add') }));
		const dialog = await body.findByRole('dialog');
		const field = within(dialog).getByLabelText(new RegExp(escapeRe(t('tn.dom.f.hostname'))));
		await userEvent.type(field, 'https://bad');
		await userEvent.click(within(dialog).getByRole('button', { name: t('tn.dom.add.submit') }));
		await within(dialog).findByText(t('tn.dom.f.hostnameInvalid'));
		await userEvent.clear(field);
		await userEvent.type(field, 'Auth.Acme.Example.');
		await userEvent.click(within(dialog).getByRole('button', { name: t('tn.dom.add.submit') }));
		await canvas.findByText('auth.acme.example');
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<div style="max-width: 880px; padding: 24px;">
			<TenantDomainsCard client={fakeTenantDomains()} tenantId="acme" canEdit />
		</div>
	{/snippet}
</Story>

<Story
	name="Custom domains: set up by hand"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tn.dom.manualNote'));
		await expect(canvas.getByText(t('tn.dom.status.pending_manual'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<div style="max-width: 880px; padding: 24px;">
			<TenantDomainsCard
				client={fakeTenantDomains({
					cloudflareConfigured: false,
					domains: [
						{
							id: 'dom_manual',
							tenantId: 'acme',
							hostname: 'sso.acme.example',
							isPrimary: false,
							isActive: true,
							status: 'pending_manual',
							sslStatus: null,
							managedByCloudflare: false,
							validationRecords: [],
							lastSyncAt: null,
							createdAt: null
						}
					]
				})}
				tenantId="acme"
				canEdit
			/>
		</div>
	{/snippet}
</Story>

<Story
	name="Custom domains: none, read-only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tn.dom.empty'));
		await expect(canvas.queryByRole('button', { name: t('tn.dom.add') })).toBeNull();
	}}
>
	{#snippet template()}
		<div style="max-width: 880px; padding: 24px;">
			<TenantDomainsCard
				client={fakeTenantDomains({ domains: [] })}
				tenantId="acme"
				canEdit={false}
			/>
		</div>
	{/snippet}
</Story>

<Story
	name="Custom domains: refused by Cloudflare, HTTP check"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tn.dom.failedNote', { hostnames: 'old.acme.example' }));
		await expect(canvas.getByText(t('tn.dom.record.howHttp'))).toBeInTheDocument();
		await expect(canvas.getByText(t('tn.dom.record.url'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<div style="max-width: 880px; padding: 24px;">
			<TenantDomainsCard
				client={fakeTenantDomains({
					domains: [
						{
							id: 'dom_failed',
							tenantId: 'acme',
							hostname: 'old.acme.example',
							isPrimary: false,
							isActive: true,
							status: 'failed',
							sslStatus: null,
							managedByCloudflare: false,
							validationRecords: [],
							lastSyncAt: null,
							createdAt: null
						},
						{
							id: 'dom_http',
							tenantId: 'acme',
							hostname: 'web.acme.example',
							isPrimary: false,
							isActive: true,
							status: 'pending',
							sslStatus: 'pending_validation',
							managedByCloudflare: true,
							validationRecords: [
								{
									kind: 'certificate',
									type: 'HTTP',
									name: 'http://web.acme.example/.well-known/acme-challenge/abc',
									value: 'abc.def'
								}
							],
							lastSyncAt: null,
							createdAt: null
						}
					]
				})}
				tenantId="acme"
				canEdit
			/>
		</div>
	{/snippet}
</Story>
