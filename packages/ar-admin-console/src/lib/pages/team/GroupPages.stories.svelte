<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { teamAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { fakeAdminGroups } from '#lib/api/fake/admin-groups-fake.js';
	import { fakeAdminTeam } from '#lib/api/fake/admin-team-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import GroupDetailPage from './GroupDetailPage.svelte';
	import GroupListPage from './GroupListPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Administrators/Groups',
		component: GroupDetailPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Administrator groups (`/admin/settings/team-groups`, `/api/admin/admin-groups`): administrators gathered under a name, who all hold the roles the group gives (in this tenant, each with an optional end). The list shows each group’s members and roles; "Create group" asks a name and a key set once (suggested from the name). A group’s page edits its name and description, adds members (found by address, several at once, each added on its own) and removes them, adds roles and changes their end or removes them, and deletes the group. A change someone else made first (409 `admin_group_changed`) is said and the group loads again; taking away the last open-ended tenant administrator is refused. Reading needs `admin:admin_users:read`; changing needs `admin:admin_roles:write` too, and giving a role `admin:admin_roles:read` to offer them.'
				}
			}
		}
	});

	const tenant = teamAccess(persona('tenant').access);
	const reader = teamAccess({
		platform: false,
		roles: [],
		permissions: ['admin:admin_users:read']
	});
	const onopen = fn();
	const ondeleted = fn();
</script>

<Story
	name="List"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Operations');
		await expect(canvas.getByRole('button', { name: t('tg.create') })).toBeVisible();
	}}
>
	{#snippet template()}
		<GroupListPage client={fakeAdminGroups({ delay: 100 })} access={tenant} {onopen} />
	{/snippet}
</Story>

<Story
	name="Create a group"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('tg.create') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(t('tg.new.name'))),
			'Night Shift'
		);
		// The key is suggested from the name.
		await expect(within(dialog).getByLabelText(new RegExp(t('tg.new.key')))).toHaveValue(
			'night-shift'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('tg.new.submit') }));
		await waitFor(() => expect(onopen).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<GroupListPage client={fakeAdminGroups()} access={tenant} {onopen} />
	{/snippet}
</Story>

<Story
	name="Key already used"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('tg.create') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(within(dialog).getByLabelText(new RegExp(t('tg.new.name'))), 'Ops');
		await userEvent.click(within(dialog).getByRole('button', { name: t('tg.new.submit') }));
		await within(dialog).findByText(t('tg.error.keyTaken'));
	}}
>
	{#snippet template()}
		<GroupListPage client={fakeAdminGroups()} access={tenant} {onopen} />
	{/snippet}
</Story>

<Story
	name="A group"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Operations' });
		await canvas.findByText('Aiko Sato');
		await canvas.findByText('Security Administrator');
	}}
>
	{#snippet template()}
		<GroupDetailPage
			groups={fakeAdminGroups({ delay: 100 })}
			team={fakeAdminTeam()}
			groupId="grp_ops"
			access={tenant}
			listHref="#groups"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Add members"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('tg.members.add') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(within(dialog).getByRole('combobox'), 'mina');
		await userEvent.click(await within(dialog).findByRole('option', { name: /Mina Kato/ }));
		await userEvent.click(within(dialog).getByRole('button', { name: t('tg.members.add.submit') }));
		await body.findByText(t('tg.toast.membersAdded', { count: 1 }));
		await canvas.findByRole('button', {
			name: t('tg.members.col.actions', { name: 'Mina Kato' })
		});
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<GroupDetailPage
			groups={fakeAdminGroups()}
			team={fakeAdminTeam()}
			groupId="grp_ops"
			access={tenant}
			listHref="#groups"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Changed meanwhile"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('tg.members.col.actions', { name: 'Ken Ito' })
			})
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('tg.members.remove') }));
		await userEvent.click(await body.findByRole('button', { name: t('tg.members.remove') }));
		await body.findByText(t('tm.error.changed'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<GroupDetailPage
			groups={fakeAdminGroups({ failOn: { removeMember: 'admin_group_changed' } })}
			team={fakeAdminTeam()}
			groupId="grp_ops"
			access={tenant}
			listHref="#groups"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Add a role"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('tg.grants.add') }));
		const dialog = await body.findByRole('dialog');
		const select = await within(dialog).findByRole('combobox', {
			name: new RegExp(t('tm.new.role'))
		});
		// Roles the group gives already are not offered.
		await waitFor(() =>
			expect(within(select).queryByRole('option', { name: 'Support' })).toBeNull()
		);
		await userEvent.selectOptions(select, 'role_ar_viewer');
		await userEvent.click(within(dialog).getByRole('button', { name: t('tg.grants.add.submit') }));
		await canvas.findByText('Viewer');
	}}
>
	{#snippet template()}
		<GroupDetailPage
			groups={fakeAdminGroups()}
			team={fakeAdminTeam()}
			groupId="grp_ops"
			access={tenant}
			listHref="#groups"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Operations' });
		await expect(canvas.queryByRole('button', { name: t('tg.members.add') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('tg.d.delete.action') })).toBeNull();
	}}
>
	{#snippet template()}
		<GroupDetailPage
			groups={fakeAdminGroups()}
			team={fakeAdminTeam()}
			groupId="grp_ops"
			access={reader}
			listHref="#groups"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story name="Not found">
	{#snippet template()}
		<GroupDetailPage
			groups={fakeAdminGroups()}
			team={fakeAdminTeam()}
			groupId="grp_nope"
			access={tenant}
			listHref="#groups"
			{ondeleted}
		/>
	{/snippet}
</Story>
