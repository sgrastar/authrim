<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { teamAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { fakeAdminRoles } from '#lib/api/fake/admin-roles-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import RoleListPage from './RoleListPage.svelte';
	import RolePage from './RolePage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Administrators/Roles',
		component: RolePage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Administrator roles (`/admin/settings/team-roles`, `/api/admin/admin-roles`): the built-in roles, shared by every tenant and read only, and this tenant’s own. A role’s page shows its rank and permissions and who holds it: the number (through groups included) and those given it directly (the ones holding it through a group are on each group’s page). A custom role is created (`…/team-roles/new`; its name set once, never `ar_…`), edited and deleted while nobody holds it. Saving sends only what changed: a change to the permissions or the rank is held to the editor’s own (a rank below theirs, permissions they hold), and the permissions offered are the ones they hold plus those the role has. Reading needs `admin:admin_roles:read`; changing `admin:admin_roles:write` too.'
				}
			}
		}
	});

	const tenantAccess = persona('tenant').access;
	const tenant = teamAccess(tenantAccess);
	const viewer = teamAccess({
		platform: false,
		roles: [],
		permissions: ['admin:admin_roles:read']
	});
	const onopen = fn();
	const oncreated = fn();
	const ondeleted = fn();
</script>

<Story
	name="List"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Billing reader');
		await expect(canvas.getByRole('link', { name: t('tr.create') })).toBeVisible();
	}}
>
	{#snippet template()}
		<RoleListPage client={fakeAdminRoles({ delay: 100 })} access={tenant} newHref="#new" {onopen} />
	{/snippet}
</Story>

<Story
	name="A built-in role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tr.d.systemNote'));
		await expect(canvas.queryByRole('button', { name: t('tr.d.save') })).toBeNull();
		await expect(canvas.getByText(t('tr.d.holders.count', { count: 2 }))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<RolePage
			client={fakeAdminRoles()}
			roleId="role_ar_tenant_admin"
			access={tenant}
			who={tenantAccess}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Edit a custom role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		const description = await canvas.findByLabelText(new RegExp(t('tr.new.description')));
		await userEvent.clear(description);
		await userEvent.type(description, 'Reads usage and invoices for finance.');
		await userEvent.click(canvas.getByRole('button', { name: t('tr.d.save') }));
		await body.findByText(t('tr.d.saved'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<RolePage
			client={fakeAdminRoles()}
			roleId="role_custom_billing"
			access={tenant}
			who={tenantAccess}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Create a role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.type(
			await canvas.findByLabelText(new RegExp(t('tr.new.name').replace(/[()]/g, '\\$&'))),
			'ar_mine'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('tr.new.submit') }));
		await canvas.findByText(t('tr.new.nameReserved'));
		await canvas.findByText(t('tr.new.permissionsNone'));
		const name = canvas.getByLabelText(new RegExp(t('tr.new.name').replace(/[()]/g, '\\$&')));
		await userEvent.clear(name);
		await userEvent.type(name, 'helpdesk');
		await userEvent.click(canvas.getAllByRole('checkbox', { name: /read/ })[0]);
		await userEvent.click(canvas.getByRole('button', { name: t('tr.new.submit') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<RolePage
			client={fakeAdminRoles()}
			roleId="new"
			access={tenant}
			who={tenantAccess}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="A role in use"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('tr.d.delete.action') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('tr.d.delete.action') }));
		await body.findByText(t('tr.error.inUse'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<RolePage
			client={fakeAdminRoles({ holders: { role_custom_billing: 1 } })}
			roleId="role_custom_billing"
			access={tenant}
			who={tenantAccess}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Billing reader' });
		await expect(canvas.queryByRole('button', { name: t('tr.d.save') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('tr.d.delete.action') })).toBeNull();
	}}
>
	{#snippet template()}
		<RolePage
			client={fakeAdminRoles()}
			roleId="role_custom_billing"
			access={viewer}
			who={{ platform: false, roles: [], permissions: ['admin:admin_roles:read'] }}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Every permission, and one * does not cover"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('checkbox', { name: t('tr.new.allPermissions') });
		// Granted by exact name only, it stays listed (and can be taken away) beside "*".
		await expect(
			canvas.getByRole('checkbox', { name: 'admin:last_resort_recovery' })
		).toBeChecked();
	}}
>
	{#snippet template()}
		<RolePage
			client={fakeAdminRoles({
				roles: [
					{
						id: 'role_custom_rescue',
						name: 'rescue',
						display_name: 'Rescue',
						description: null,
						permissions: ['*', 'admin:last_resort_recovery'],
						hierarchy_level: 10,
						is_system: false,
						inherits_from: null,
						updated_at: 0
					}
				]
			})}
			roleId="role_custom_rescue"
			access={tenant}
			who={persona('platform').access}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="A permission taken away and back"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Unticked before saving, a permission the role had stays offered, though the editor
		// does not hold it.
		const label = /^read.*View end user audit logs/;
		await userEvent.click(await canvas.findByRole('checkbox', { name: label }));
		await expect(canvas.getByRole('checkbox', { name: label })).not.toBeChecked();
		await userEvent.click(canvas.getByRole('checkbox', { name: label }));
		await expect(canvas.getByRole('checkbox', { name: label })).toBeChecked();
	}}
>
	{#snippet template()}
		<RolePage
			client={fakeAdminRoles()}
			roleId="role_custom_billing"
			access={tenant}
			who={{ platform: false, roles: [], permissions: ['admin:admin_roles:*'] }}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Step-up cancelled on a wider role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Giving the role a permission it lacks widens it: the step-up is asked, and cancelled.
		await userEvent.click(await canvas.findByRole('checkbox', { name: /^read.*View end users/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('tr.d.save') }));
		await canvas.findByText(t('tm.error.cancelled'));
	}}
>
	{#snippet template()}
		<RolePage
			client={fakeAdminRoles({ cancelStepUp: true })}
			roleId="role_custom_billing"
			access={tenant}
			who={tenantAccess}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story name="Not found">
	{#snippet template()}
		<RolePage
			client={fakeAdminRoles()}
			roleId="role_nope"
			access={tenant}
			who={tenantAccess}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>
