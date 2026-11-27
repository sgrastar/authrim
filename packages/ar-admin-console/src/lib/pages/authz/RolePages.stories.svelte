<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { authzAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { createFakeAuthz } from '#lib/api/fake/end-user-authz-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import EndUserRoleListPage from './EndUserRoleListPage.svelte';
	import EndUserRolePage from './EndUserRolePage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Access/Roles',
		component: EndUserRolePage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Access → Roles (`/admin/access/roles`, `/api/admin/roles`): the roles the tenant’s users are given, directly (`/api/admin/users/:id/roles`) or through a group. Each is a set of `resource:action` permissions with a **grant tier** (1–3): an administrator creates, changes, gives and takes away only roles up to their own ceiling (the highest tier of their admin roles: 3 for a super administrator, 2 for a tenant administrator, 1 otherwise), shown on the list and the editor. A role’s page shows its permissions and the users given it directly (a page at a time; those holding it through a group are on each group’s page). A preset role, or one above the ceiling, is shown as it is. Deleting is refused while anyone or any group has it. Reading needs `admin:roles:read`; changing `admin:roles:write`; deleting `admin:roles:delete`.'
				}
			}
		}
	});

	const tenant = authzAccess(persona('tenant').access);
	const support = authzAccess(persona('support').access);
	const viewer = authzAccess(persona('viewer').access);
	const onopen = fn();
	const oncreated = fn();
	const ondeleted = fn();
	const body = (element: HTMLElement) => within(element.ownerDocument.body);
</script>

<Story
	name="List"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('billing_admin');
		await expect(canvas.getByText(t('eur.ceiling', { ceiling: 2 }))).toBeVisible();
		await expect(canvas.getByRole('link', { name: t('eur.create') })).toBeVisible();
	}}
>
	{#snippet template()}
		<EndUserRoleListPage
			client={createFakeAuthz({ delay: 100 }).roles}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="Empty list">
	{#snippet template()}
		<EndUserRoleListPage
			client={createFakeAuthz({ roles: [] }).roles}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="List failed">
	{#snippet template()}
		<EndUserRoleListPage
			client={createFakeAuthz({ failOn: { 'roles.list': 500 } }).roles}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Create a role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		const name = await canvas.findByLabelText(new RegExp(t('eur.new.name')));
		await userEvent.type(name, 'end_user');
		await userEvent.click(canvas.getByRole('button', { name: t('eur.new.submit') }));
		await canvas.findByText(t('eur.new.nameReserved'));
		await canvas.findByText(t('eur.new.permissionsNone'));
		await userEvent.clear(name);
		await userEvent.type(name, 'reviewer');
		await userEvent.click(canvas.getByRole('button', { name: t('eur.new.addPermission') }));
		await userEvent.keyboard('documents:review');
		await userEvent.click(canvas.getByRole('button', { name: t('eur.new.submit') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<EndUserRolePage
			client={createFakeAuthz().roles}
			roleId="new"
			access={tenant}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Edit a role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		const description = await canvas.findByLabelText(new RegExp(t('eur.new.description')));
		await userEvent.clear(description);
		await userEvent.type(description, 'Edits and publishes documents.');
		await userEvent.click(canvas.getByRole('button', { name: t('eur.d.save') }));
		await body(canvasElement).findByText(t('eur.d.saved'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<EndUserRolePage
			client={createFakeAuthz().roles}
			roleId="role_editor"
			access={tenant}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Above the admin’s ceiling"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('eur.d.aboveCeiling', { ceiling: 1 }));
		await expect(canvas.queryByRole('button', { name: t('eur.d.save') })).toBeNull();
	}}
>
	{#snippet template()}
		<EndUserRolePage
			client={createFakeAuthz({ ceiling: 1 }).roles}
			roleId="role_billing"
			access={support}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="A preset role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('eur.d.systemNote'));
		await expect(canvas.queryByRole('button', { name: t('eur.d.delete.action') })).toBeNull();
	}}
>
	{#snippet template()}
		<EndUserRolePage
			client={createFakeAuthz().roles}
			roleId="role_end_user"
			access={tenant}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Given to groups"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('eur.d.groups.count', { count: 2 }));
		await expect(canvas.getByText('Engineering')).toBeVisible();
		await expect(canvas.getAllByText(t('grp.members.noEnd')).length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		<EndUserRolePage
			client={createFakeAuthz().roles}
			roleId="role_editor"
			access={tenant}
			listHref="#roles"
			{oncreated}
			{ondeleted}
			onopengroup={onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Group grants could not be loaded"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('eur.d.groups.loadFailed'));
		// The role and the users given it are still shown.
		await expect(canvas.getByRole('heading', { name: t('eur.d.holders') })).toBeVisible();
	}}
>
	{#snippet template()}
		<EndUserRolePage
			client={createFakeAuthz({ failOn: { 'roles.groupAssignments': 500 } }).roles}
			roleId="role_editor"
			access={tenant}
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
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('eur.d.delete.action') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('eur.d.delete.action') }));
		await body(canvasElement).findByText(t('eur.error.inUse'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<EndUserRolePage
			client={createFakeAuthz().roles}
			roleId="role_editor"
			access={tenant}
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
		await canvas.findByRole('heading', { name: 'editor' });
		await expect(canvas.queryByRole('button', { name: t('eur.d.save') })).toBeNull();
	}}
>
	{#snippet template()}
		<EndUserRolePage
			client={createFakeAuthz().roles}
			roleId="role_editor"
			access={viewer}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story name="Not found">
	{#snippet template()}
		<EndUserRolePage
			client={createFakeAuthz().roles}
			roleId="role_nope"
			access={tenant}
			listHref="#roles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>
