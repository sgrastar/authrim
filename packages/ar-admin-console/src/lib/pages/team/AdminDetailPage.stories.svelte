<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { teamAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { fakeAdminTeam } from '#lib/api/fake/admin-team-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import AdminDetailPage from './AdminDetailPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Administrators/Administrator',
		component: AdminDetailPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Administrators → one administrator (`/admin/settings/team/<id>`, `GET /api/admin/admins/:id`): name and address (editable; a new address asks for a step-up), state (suspend, reactivate, unlock), the roles held, their admin groups, their passkeys, and deleting them. Each role says where it comes from: given directly (its end can be changed through `PATCH /api/admin/admin-roles/:role/assignments/:id`, or it can be removed) or through an admin group (changed in the group). "Give role" adds a direct role: never the super administrator, which a peer is given by invitation; a role for every tenant only for an administrator of the default tenant, by an admin with global authority. Refusals name their reason (the last administrator, a role already held, oneself…).\n\nWhat each kind of admin sees follows the API: reading needs `admin:admin_users:read`, editing and state `…:write`, deleting and removing a role `…:delete` (a DELETE), giving and changing roles `admin:admin_roles:write` (and `…:read` to offer them).'
				}
			}
		}
	});

	const ondeleted = fn();
	const tenant = teamAccess(persona('tenant').access);
	const platform = teamAccess(persona('platform').access);
	const viewer = teamAccess({
		platform: false,
		roles: [],
		permissions: ['admin:admin_users:read']
	});
</script>

<Story
	name="Administrator"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Aiko Sato' });
		await canvas.findByText(t('tm.d.source.group', { name: 'Operations' }));
		// Later cards fade in as the page is entered.
		await waitFor(() =>
			expect(
				canvas.getByRole('button', {
					name: t('tm.d.roles.col.actions', { name: 'Tenant Administrator' })
				})
			).toBeVisible()
		);
		// A role from a group is changed in the group: no actions here.
		await expect(
			canvas.queryByRole('button', {
				name: t('tm.d.roles.col.actions', { name: 'Security Administrator' })
			})
		).toBeNull();
	}}
>
	{#snippet template()}
		<AdminDetailPage
			client={fakeAdminTeam({ delay: 100 })}
			adminId="adm_1"
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Give a role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('tm.d.grant') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.selectOptions(
			await within(dialog).findByRole('combobox', { name: new RegExp(t('tm.new.role')) }),
			'role_ar_viewer'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('tm.d.grant.submit') }));
		await body.findByText(t('tm.toast.granted', { role: 'Viewer' }));
		await canvas.findByRole('button', { name: t('tm.d.roles.col.actions', { name: 'Viewer' }) });
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AdminDetailPage
			client={fakeAdminTeam()}
			adminId="adm_2"
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Role already held"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('tm.d.grant') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.selectOptions(
			await within(dialog).findByRole('combobox', { name: new RegExp(t('tm.new.role')) }),
			'role_ar_support'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('tm.d.grant.submit') }));
		await within(dialog).findByText(t('tm.error.roleHeld'));
	}}
>
	{#snippet template()}
		<AdminDetailPage
			client={fakeAdminTeam()}
			adminId="adm_2"
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Last administrator's role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('tm.d.roles.col.actions', { name: 'Tenant Administrator' })
			})
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('tm.d.action.remove') }));
		await userEvent.click(await body.findByRole('button', { name: t('tm.d.action.remove') }));
		await body.findByText(t('tm.error.lastTenantAdmin'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AdminDetailPage
			client={fakeAdminTeam()}
			adminId="adm_1"
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Aiko Sato' });
		await expect(canvas.queryByRole('button', { name: t('tm.d.grant') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('tm.d.edit') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('tm.d.delete.action') })).toBeNull();
	}}
>
	{#snippet template()}
		<AdminDetailPage
			client={fakeAdminTeam()}
			adminId="adm_1"
			access={viewer}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="A role that ended, given again"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('tm.d.grant') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.selectOptions(
			await within(dialog).findByRole('combobox', { name: new RegExp(t('tm.new.role')) }),
			'role_ar_viewer'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('tm.d.grant.submit') }));
		await within(dialog).findByText(t('tm.d.grant.endedFound'));
		await userEvent.click(within(dialog).getByRole('button', { name: t('tm.d.grant.renew') }));
		await body.findByText(t('tm.toast.granted', { role: 'Viewer' }));
		// Reloaded: the assignment is back as Viewer, and Support is as it was.
		await canvas.findByRole('button', { name: t('tm.d.roles.col.actions', { name: 'Viewer' }) });
		await expect(
			canvas.getByRole('button', { name: t('tm.d.roles.col.actions', { name: 'Support' }) })
		).toBeInTheDocument();
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AdminDetailPage
			client={fakeAdminTeam({
				ended: [
					{ roleId: 'role_ar_viewer', adminId: 'adm_2', scope: 'tenant', assignmentId: 'asg_old' }
				]
			})}
			adminId="adm_2"
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="An end on the last administrator's role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('tm.d.roles.col.actions', { name: 'Tenant Administrator' })
			})
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('tm.d.action.expiry') }));
		const dialog = await body.findByRole('dialog');
		const field = within(dialog).getByLabelText(new RegExp(t('tm.new.roleEnds')));
		// A datetime-local field is typed segment by segment; set the value as the field would.
		(field as HTMLInputElement).value = '2030-01-01T09:00';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		await userEvent.click(within(dialog).getByRole('button', { name: t('tm.d.expiry.submit') }));
		await within(dialog).findByText(t('tm.error.lastTenantAdmin'));
		await expect(field).toHaveValue('2030-01-01T09:00');
	}}
>
	{#snippet template()}
		<AdminDetailPage
			client={fakeAdminTeam()}
			adminId="adm_1"
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
			zone="utc"
		/>
	{/snippet}
</Story>

<Story name="Platform admin: roles for every tenant">
	{#snippet template()}
		<AdminDetailPage
			client={fakeAdminTeam()}
			adminId="adm_2"
			access={platform}
			tenantId="acme"
			listHref="#team"
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
		await userEvent.click(await canvas.findByRole('button', { name: t('tm.d.delete.action') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('tm.d.delete.action') }));
		await waitFor(() => expect(ondeleted).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AdminDetailPage
			client={fakeAdminTeam()}
			adminId="adm_2"
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story name="Not found">
	{#snippet template()}
		<AdminDetailPage
			client={fakeAdminTeam()}
			adminId="adm_nope"
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{ondeleted}
		/>
	{/snippet}
</Story>
