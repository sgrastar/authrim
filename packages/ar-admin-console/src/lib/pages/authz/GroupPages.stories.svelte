<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { authzAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { createFakeAdminUsers } from '#lib/api/fake/admin-users-fake.js';
	import { createFakeAuthz } from '#lib/api/fake/end-user-authz-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import GroupListPage from './GroupListPage.svelte';
	import GroupPage from './GroupPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Users/Groups',
		component: GroupPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Users → Groups (`/admin/users/groups`, `/api/admin/groups`): the tenant’s groups of users — standard, dynamic (the service-group catalog owns them, key `dynamic:<id>`), from SCIM or provisioning rules — found by key or name and narrowed by kind and state. **Create group** makes a standard group (with an optional parent) or a dynamic one (`POST /api/admin/service-groups`; its rule is set on its page). A group’s page shows its key, kind, parent and state, and tabs: **Members** (one row per source with whether it grants now; manual rows are added and removed here, the others at their source), **Roles** (given to everyone in it and below it, with where each holds and when it ends, held to the admin’s grant ceiling), **Hierarchy** (the groups above and below) and, for a dynamic group, **Dynamic rule** (the condition, on/off and name, saved with the catalog revision read; the evaluation progress per account store). Deleting is refused with the reason while the group has child groups or is another grant’s scope; a dynamic group is deleted through its rule. Reading needs `admin:groups:read`; changing `admin:groups:write`, and a group that carries roles also `admin:roles:write` with a grant tier covering them; a rule `admin:users:write`.'
				}
			}
		}
	});

	const tenant = authzAccess(persona('tenant').access);
	const viewer = authzAccess(persona('viewer').access);
	const users = createFakeAdminUsers();
	const onopen = fn();
	const ondeleted = fn();
	const groupHref = (id: string) => `#group-${id}`;
	const body = (element: HTMLElement) => within(element.ownerDocument.body);

	/** A dynamic group whose rule is one comparison (not a group of them), as an API may hold it. */
	const SINGLE = {
		op: 'attribute' as const,
		field: 'country',
		compare: 'eq' as const,
		value: 'JP'
	};
	function singleRule() {
		const fake = createFakeAuthz({
			catalog: {
				revision: 3,
				groups: [
					{
						id: 'grp_jp',
						key: 'jp',
						displayName: 'Japan office',
						description: '',
						enabled: true,
						condition: SINGLE
					}
				],
				fields: { country: { type: 'string', pii: false, selfWritable: false } },
				scans: []
			}
		});
		const sent = fn();
		return {
			fake,
			sent,
			groups: {
				...fake.groups,
				saveDynamic: (...args: Parameters<typeof fake.groups.saveDynamic>) => {
					sent(args[0].condition);
					return fake.groups.saveDynamic(...args);
				}
			}
		};
	}
	const renamed = singleRule();

	/** A rule save that does not reach every shard, after which the group cannot be read again. */
	function pendingThenUnreadable() {
		const fake = createFakeAuthz({ expiryPending: true });
		let saved = false;
		return {
			fake,
			groups: {
				...fake.groups,
				saveDynamic: async (...args: Parameters<typeof fake.groups.saveDynamic>) => {
					const result = await fake.groups.saveDynamic(...args);
					saved = true;
					return result;
				},
				get: (...args: Parameters<typeof fake.groups.get>) =>
					saved ? Promise.reject(new Error('unreachable')) : fake.groups.get(...args)
			}
		};
	}
	const unreadable = pendingThenUnreadable();
	/** May write the service-group catalog (users' permissions) but not the groups API. */
	const rulesOnly = authzAccess({
		platform: false,
		roles: [],
		permissions: ['admin:groups:read', 'admin:users:read', 'admin:users:write']
	});
</script>

<Story
	name="List"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Engineering');
		await expect(canvas.getByText('Japan office')).toBeVisible();
		await expect(canvas.getByRole('button', { name: t('grp.create') })).toBeVisible();
	}}
>
	{#snippet template()}
		<GroupListPage client={createFakeAuthz({ delay: 100 }).groups} access={tenant} {onopen} />
	{/snippet}
</Story>

<Story name="Empty list">
	{#snippet template()}
		<GroupListPage client={createFakeAuthz({ groups: [] }).groups} access={tenant} {onopen} />
	{/snippet}
</Story>

<Story name="List failed">
	{#snippet template()}
		<GroupListPage
			client={createFakeAuthz({ failOn: { 'groups.list': 500 } }).groups}
			access={tenant}
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="No access">
	{#snippet template()}
		<GroupListPage
			client={createFakeAuthz({ failOn: { 'groups.list': 403 } }).groups}
			access={authzAccess({ platform: false, roles: [], permissions: [] })}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Create a group"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('grp.create') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(t('grp.new.name'))),
			'Night Shift'
		);
		// The key is suggested from the name.
		await expect(within(dialog).getByLabelText(new RegExp(t('grp.new.key')))).toHaveValue(
			'night-shift'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('grp.new.submit') }));
		await waitFor(() => expect(onopen).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<GroupListPage client={createFakeAuthz().groups} access={tenant} {onopen} />
	{/snippet}
</Story>

<Story
	name="A group’s members"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Engineering' });
		await canvas.findByText('Aiko Sato');
		await expect(canvas.getAllByText(t('grp.source.manual')).length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_eng"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="A membership from another source"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// A SCIM row has no menu: it is changed at its source.
		await canvas.findByText('Ben Okafor');
		await expect(
			canvas.queryByRole('button', { name: t('grp.members.col.actions', { name: 'Ben Okafor' }) })
		).toBeNull();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_sales"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Give a role to a group"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('tab', { name: new RegExp(t('grp.tab.roles')) }));
		await userEvent.click(await canvas.findByRole('button', { name: t('grp.roles.add') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		// Billing admin is tier 3, above a tenant administrator's ceiling: not offered.
		await expect(within(dialog).getByText(t('az.grant.roleHidden', { ceiling: 2 }))).toBeVisible();
		await userEvent.selectOptions(
			within(dialog).getByRole('combobox', { name: new RegExp(`^${t('az.grant.role')}`) }),
			'role_editor'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('az.grant.submit') }));
		await body(canvasElement).findByText(t('grp.toast.roleGranted'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<Toaster />
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_backend"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story name="Hierarchy" args={{}}>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_eng"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
			tab="tree"
		/>
	{/snippet}
</Story>

<Story
	name="A dynamic group’s rule"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await canvas.findByRole('heading', { name: t('grp.rule.title') });
		await userEvent.click(canvas.getByRole('button', { name: t('grp.rule.save') }));
		await body(canvasElement).findByText(t('grp.rule.saved'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<Toaster />
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_jp"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
			tab="rule"
		/>
	{/snippet}
</Story>

<Story
	name="A rule someone else saved first"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: t('grp.rule.title') });
		await userEvent.click(canvas.getByRole('button', { name: t('grp.rule.save') }));
		await canvas.findByText(t('grp.error.catalogChanged'));
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz({ failOn: { 'groups.saveDynamic': 'group_version_conflict' } })}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_jp"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
			tab="rule"
		/>
	{/snippet}
</Story>

<Story
	name="Delete refused: child groups"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('grp.d.delete.action') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('grp.d.delete.action') }));
		await body(canvasElement).findByText(t('grp.error.hasChildren'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<Toaster />
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_eng"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Engineering' });
		await expect(canvas.queryByRole('button', { name: t('grp.d.edit') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('grp.members.add') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('grp.d.delete.action') })).toBeNull();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_eng"
			access={viewer}
			listHref="#groups"
			{groupHref}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story name="Not found">
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_nope"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story name="Load failed">
	{#snippet template()}
		{@const fake = createFakeAuthz({ failOn: { 'groups.get': 500 } })}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_eng"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Rename a dynamic group: its rule is sent as read"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await canvas.findByRole('heading', { name: t('grp.rule.title') });
		const name = canvas.getAllByLabelText(new RegExp(t('grp.new.name')))[0];
		await userEvent.clear(name);
		await userEvent.type(name, 'Tokyo office');
		await userEvent.click(canvas.getByRole('button', { name: t('grp.rule.save') }));
		await body(canvasElement).findByText(t('grp.rule.saved'));
		// The single comparison, byte for byte: not wrapped in all([...]).
		await expect(renamed.sent).toHaveBeenCalledWith(SINGLE);
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<GroupPage
			client={renamed.groups}
			roles={renamed.fake.roles}
			{users}
			groupId="grp_jp"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
			tab="rule"
		/>
	{/snippet}
</Story>

<Story
	name="A rule saved without reaching every shard"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await canvas.findByRole('heading', { name: t('grp.rule.title') });
		await userEvent.click(canvas.getByRole('button', { name: t('grp.rule.save') }));
		await canvas.findByText(t('grp.rule.savedExpiryPending'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz({ expiryPending: true })}
		<Toaster />
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_jp"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
			tab="rule"
		/>
	{/snippet}
</Story>

<Story
	name="Members the admin may not change"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The API says no (its roles are above the admin's ceiling): adding and removing are left out.
		await canvas.findByText('Aiko Sato');
		await expect(canvas.queryByRole('button', { name: t('grp.members.add') })).toBeNull();
		await expect(
			canvas.queryByRole('button', { name: t('grp.members.col.actions', { name: 'Aiko Sato' }) })
		).toBeNull();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz({ ceiling: 0 })}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_eng"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Create: only the dynamic kind"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('grp.create') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		// No choice to make, and the dynamic key rule applies.
		await expect(within(dialog).queryByRole('radiogroup')).toBeNull();
		await expect(within(dialog).getByText(t('grp.new.dynamicKeyHint'))).toBeVisible();
	}}
>
	{#snippet template()}
		<GroupListPage client={createFakeAuthz().groups} access={rulesOnly} {onopen} />
	{/snippet}
</Story>

<Story
	name="Hierarchy failed to load"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Children that could not be read are not shown as "no groups below".
		await canvas.findByText(t('grp.tree.loadFailed'));
		await expect(canvas.queryByText(t('grp.tree.noChildren'))).toBeNull();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz({ failOn: { 'groups.children': 500 } })}
		<GroupPage
			client={fake.groups}
			roles={fake.roles}
			{users}
			groupId="grp_eng"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
			tab="tree"
		/>
	{/snippet}
</Story>

<Story
	name="Pending expiry, then the group could not be read again"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await canvas.findByRole('heading', { name: t('grp.rule.title') });
		await userEvent.click(canvas.getByRole('button', { name: t('grp.rule.save') }));
		// The tabs are gone with the group, the warning is not.
		await canvas.findAllByText(t('grp.d.loadFailed'));
		await expect(canvas.getByText(t('grp.rule.savedExpiryPending'))).toBeVisible();
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<GroupPage
			client={unreadable.groups}
			roles={unreadable.fake.roles}
			{users}
			groupId="grp_jp"
			access={tenant}
			listHref="#groups"
			{groupHref}
			{ondeleted}
			tab="rule"
		/>
	{/snippet}
</Story>
