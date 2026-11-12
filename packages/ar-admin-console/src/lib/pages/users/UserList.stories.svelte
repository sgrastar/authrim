<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { createFakeAdminUsers, sampleUsers } from '#lib/api/fake/admin-users-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import UserList from './UserList.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Users/All users',
		component: UserList,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Users → All users (`/admin/users/all`, `/api/admin/users`): the tenant’s end users, newest registration first, in one table (user, status, last sign-in, registered). Where accounts are sharded the API cannot filter, sort, count or search partly: the search box finds one user by exact email address or user ID, and sends its request on Enter or clear, not while typing. More users are read with **Load more** (a cursor, or a page number where the API counts, which also gives the total). A cursor that went stale is dropped and the list starts again from the first page. **Add user** asks for an email address and an optional name; a taken address is said at the field. Reading needs `admin:users:read`, adding `admin:users:write`. The stories use an in-memory API with the same rules.'
				}
			}
		}
	});

	const writer: AdminAccess = {
		platform: false,
		roles: ['ar_tenant_admin'],
		permissions: ['admin:users:read', 'admin:users:write']
	};
	const reader: AdminAccess = {
		platform: false,
		roles: ['ar_viewer'],
		permissions: ['admin:users:read']
	};
	const onopen = fn();
	const first = sampleUsers()[0];

	/** Reads the first page, then fails every following one. */
	function failingMore(): AdminUsersClient {
		const inner = createFakeAdminUsers();
		return {
			...inner,
			async list(query, signal) {
				if (query.at) throw new ApiError(500, 'error', 'Could not list');
				return inner.list(query, signal);
			}
		};
	}

	const rows = (canvas: ReturnType<typeof within>) => canvas.getAllByRole('row').length - 1;
	const searchBox = (canvas: ReturnType<typeof within>) =>
		canvas.getByRole('searchbox', { name: t('usr.search') });
</script>

<Story name="Normal">
	{#snippet template()}
		<UserList client={createFakeAdminUsers({ delay: 200 })} access={writer} {onopen} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<UserList client={createFakeAdminUsers({ hang: true })} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.loadFailed'));
		await userEvent.click(canvas.getByRole('button', { name: t('common.retry') }));
		await canvas.findByText(t('usr.loadFailed'));
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers({ fail: 500 })} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.noAccess'));
		expect(canvas.queryByRole('button', { name: t('usr.add') })).toBeNull();
	}}
>
	{#snippet template()}
		<UserList
			client={createFakeAdminUsers({ fail: 403 })}
			access={persona('support').access}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByRole('row');
		await canvas.findByText(first.name!);
		expect(canvas.queryByRole('button', { name: t('usr.add') })).toBeNull();
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers()} access={reader} {onopen} />
	{/snippet}
</Story>

<Story
	name="Empty"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.empty'));
		// The page header and the empty state both offer it.
		expect(canvas.getAllByRole('button', { name: t('usr.add') })).toHaveLength(2);
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers({ empty: true })} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Search with no match"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(first.name!);
		// A part of an address finds nothing: the search is an exact match.
		await userEvent.type(searchBox(canvas), `${first.email!.slice(0, 6)}{Enter}`);
		await canvas.findByText(t('usr.noMatch'));
		await canvas.findByText(t('usr.noMatch.body'));
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers()} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Search finds one"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(first.name!);
		await userEvent.type(searchBox(canvas), `${first.email}{Enter}`);
		await waitFor(() => expect(rows(canvas)).toBe(1));
		await canvas.findByText(first.name!);
		await userEvent.click(canvas.getByRole('button', { name: t('filter.clearAll') }));
		await waitFor(() => expect(rows(canvas)).toBeGreaterThan(1));
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers()} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Load more"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const more = await canvas.findByRole('button', { name: t('usr.more') });
		await waitFor(() => expect(rows(canvas)).toBe(50));
		await userEvent.click(more);
		await waitFor(() => expect(rows(canvas)).toBe(100));
		expect(canvas.queryByRole('button', { name: t('usr.more') })).toBeNull();
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers()} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Load more with a total"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('filter.results', { n: 100 }));
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.more') }));
		await waitFor(() => expect(rows(canvas)).toBe(100));
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers({ shape: 'page' })} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Load more failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.more') }));
		await canvas.findByText(t('usr.moreFailed'));
		// What was read stays, and the next page can be asked for again.
		expect(rows(canvas)).toBe(50);
		await canvas.findByRole('button', { name: t('usr.more') });
	}}
>
	{#snippet template()}
		<UserList client={failingMore()} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Cursor went stale"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.more') }));
		// The list starts again from the first page, without an error.
		await waitFor(() => expect(rows(canvas)).toBe(50));
		expect(canvas.queryByText(t('usr.moreFailed'))).toBeNull();
		await canvas.findByRole('button', { name: t('usr.more') });
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers({ staleOnce: true })} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Add user"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		onopen.mockClear();
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.add') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(t('usr.new.email'))),
			'hana.test@example.com'
		);
		await userEvent.type(within(dialog).getByLabelText(new RegExp(t('usr.new.name'))), 'Hana Test');
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.new.submit') }));
		await waitFor(() => expect(onopen).toHaveBeenCalled());
		await body.findByText(t('usr.toast.created', { name: 'Hana Test' }));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserList client={createFakeAdminUsers()} access={writer} {onopen} />
	{/snippet}
</Story>

<Story
	name="Add user: address already used"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.add') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(t('usr.new.email'))),
			first.email!
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.new.submit') }));
		await within(dialog).findByText(t('usr.new.emailTaken'));
		// The dialog stays open for another address.
		expect(dialog).toBeVisible();
	}}
>
	{#snippet template()}
		<UserList client={createFakeAdminUsers()} access={writer} {onopen} />
	{/snippet}
</Story>
