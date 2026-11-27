<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { USERS_NOW, createFakeAdminUsers, sampleUsers } from '#lib/api/fake/admin-users-fake.js';
	import {
		createFakeAuthz,
		sampleGroup,
		sampleGroups,
		sampleMember
	} from '#lib/api/fake/end-user-authz-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import UserDetailPage from './UserDetailPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Users/User detail',
		component: UserDetailPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Users → All users → one user (`/admin/users/all/<id>`, `GET /api/admin/users/:id`): one page, no tabs. **Basic information** (the profile; **Edit** changes the name, given and family name, username and phone number, not the address), **Sign-in methods** (passkeys and authenticator apps, read only), **Sessions** (`GET /api/admin/sessions?user_id=`; **Sign out everywhere** asks for a step-up first) and **Recent activity** (the last ten events of the last 7 days; **View in audit logs** opens the full log; when even that period holds too many events to read, the card says so instead of showing a list). Each section loads on its own: one that fails says so with **Try again** and the rest stays; a section the admin has no permission for is not shown. The **⋯** menu holds only what the admin may do: suspend and lock (an active user), reactivate (a suspended or locked one) and delete. Suspending, locking and reactivating need `admin:users:write` **and** a tenant administrator’s role, as the API checks; deleting needs `admin:users:delete`, sessions `admin:sessions:read` / `admin:sessions:revoke`. A suspended or locked user can be read without its sign-in methods (`restricted`): the page says so and leaves that section out. A user under legal hold cannot be deleted; a state that changed meanwhile is read again. The stories use an in-memory API with the same rules.'
				}
			}
		}
	});

	const NORMAL = 'usr_1006';
	const SUSPENDED = 'usr_1003';
	const LOCKED = 'usr_1008';
	const DELETED = 'usr_1012';
	const NEVER = 'usr_1004';

	const tenant = persona('tenant').access;
	const viewer = persona('viewer').access;
	const nobody: AdminAccess = { platform: false, roles: [], permissions: [] };

	const ondeleted = fn();
	const onopenaudit = fn();

	/** The normal user in Backend (below Engineering, which gives the editor role) and given a role directly. */
	function authzFor(userId: string) {
		const who = { id: userId, email: '', name: '' };
		const fake = createFakeAuthz({
			members: {
				grp_backend: [sampleMember(who, 'manual')],
				grp_jp: [sampleMember(who, 'dynamic', { effective: false })]
			},
			userRoles: {
				[userId]: [
					{
						id: 'ura_9',
						role_id: 'role_billing',
						role_name: 'billing_admin',
						role_display_name: null,
						scope_type: 'resource',
						scope_target: 'resource:invoices:2026',
						expires_at: null,
						created_at: USERS_NOW
					}
				]
			}
		});
		return { groups: fake.groups, roles: fake.roles, groupHref: (id: string) => `#group-${id}` };
	}

	/** In two sibling groups below Engineering: its role reaches the user by two paths. */
	function siblingsFor(userId: string) {
		const who = { id: userId, email: '', name: '' };
		const fake = createFakeAuthz({
			groups: [
				...sampleGroups(),
				sampleGroup('grp_frontend', 'engineering.frontend', 'Frontend', {
					parent_group_id: 'grp_eng'
				})
			],
			members: {
				grp_backend: [sampleMember(who, 'manual')],
				grp_frontend: [sampleMember(who, 'manual')]
			},
			userRoles: {}
		});
		return { groups: fake.groups, roles: fake.roles, groupHref: (id: string) => `#group-${id}` };
	}

	/** The sample users, with the suspended one given an end. */
	function withEnds() {
		return sampleUsers().map((user) =>
			user.id === SUSPENDED ? { ...user, suspended_until: USERS_NOW + 72 * 3_600_000 } : user
		);
	}

	const nameOf = (id: string) => sampleUsers().find((user) => user.id === id)!.name!;
	const menu = (canvas: ReturnType<typeof within>, id: string) =>
		canvas.findByRole('button', { name: t('usr.d.actions', { name: nameOf(id) }) });
	const body = (element: HTMLElement) => within(element.ownerDocument.body);

	async function choose(
		element: HTMLElement,
		action: 'suspend' | 'lock' | 'activate' | 'delete',
		id: string
	) {
		const canvas = within(element);
		await userEvent.click(await menu(canvas, id));
		await userEvent.click(
			await body(element).findByRole('menuitem', { name: t(`usr.action.${action}`) })
		);
		return body(element).findByRole('dialog');
	}
</script>

<Story name="Normal" args={{}}>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers({ delay: 100, now: USERS_NOW })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
			{onopenaudit}
		/>
	{/snippet}
</Story>

<Story
	name="Groups and effective roles"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('az.user.title'));
		await canvas.findByRole('link', { name: 'Backend' });
		// Engineering's role reaches the user through Backend.
		await canvas.findByText(t('az.user.via.through', { group: 'Backend' }));
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers({ now: USERS_NOW })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
			authz={authzFor(NORMAL)}
		/>
	{/snippet}
</Story>

<Story
	name="Roles reaching a user through two sibling groups"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('az.user.via.through', { group: 'Backend' }));
		await expect(canvas.getByText(t('az.user.via.through', { group: 'Frontend' }))).toBeVisible();
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers({ now: USERS_NOW })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
			authz={siblingsFor(NORMAL)}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers({ hang: true })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Not found"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.d.notFound'));
		// The way back is in the header and offered where the user would have been.
		expect(canvas.getAllByRole('link', { name: t('usr.back') })).toHaveLength(2);
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId="usr_missing"
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
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
		<UserDetailPage
			client={createFakeAdminUsers({ failDetail: 500 })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.noAccess'));
		expect(canvas.queryByText(t('usr.d.basic'))).toBeNull();
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NORMAL}
			access={nobody}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.d.basic'));
		expect(canvas.queryByRole('button', { name: t('usr.d.edit') })).toBeNull();
		expect(
			canvas.queryByRole('button', { name: t('usr.d.actions', { name: nameOf(NORMAL) }) })
		).toBeNull();
		expect(canvas.queryByRole('button', { name: t('usr.d.signOut') })).toBeNull();
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NORMAL}
			access={viewer}
			listHref="#users"
			{ondeleted}
			{onopenaudit}
		/>
	{/snippet}
</Story>

<Story
	name="Suspended user"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.status.suspended'));
		await canvas.findByText(t('usr.d.suspendedUntil'));
		await userEvent.click(await menu(canvas, SUSPENDED));
		const items = body(canvasElement);
		await items.findByRole('menuitem', { name: t('usr.action.activate') });
		expect(items.queryByRole('menuitem', { name: t('usr.action.suspend') })).toBeNull();
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers({ users: withEnds(), now: USERS_NOW })}
			userId={SUSPENDED}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Locked user (restricted)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.status.locked'));
		await canvas.findByText(t('usr.d.restricted'));
		// Not read, so not claimed to be empty.
		expect(canvas.queryByText(t('usr.d.methods'))).toBeNull();
		// The API cannot resolve such an account to change it, so Edit is not offered.
		expect(canvas.queryByRole('button', { name: t('usr.d.edit') })).toBeNull();
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers({ restricted: true })}
			userId={LOCKED}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Personal data deleted"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: t('usr.piiDeleted') });
		expect(canvas.queryByRole('button', { name: t('usr.d.edit') })).toBeNull();
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={DELETED}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="No sign-in methods or sessions"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.d.methods.empty'));
		await canvas.findByText(t('usr.d.sessions.empty'));
		await canvas.findByText(t('usr.d.activity.empty'));
		expect(canvas.queryByRole('button', { name: t('usr.d.signOut') })).toBeNull();
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NEVER}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Sessions failed to load"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.d.section.failed'));
		// The rest of the page is fine.
		await canvas.findByText(t('usr.d.basic'));
		await canvas.findByText(t('usr.d.methods'));
		await canvas.findByRole('heading', { name: t('usr.d.activity') });
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers({ failSessions: true })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Edit profile"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.d.edit') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		const field = within(dialog).getByRole('textbox', { name: new RegExp(`^${t('usr.d.name')}`) });
		await userEvent.clear(field);
		await userEvent.type(field, 'Gustav S.');
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.d.edit.save') }));
		await body(canvasElement).findByText(t('usr.toast.saved'));
		await canvas.findByRole('heading', { name: 'Gustav S.' });
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Edit profile with a mistake"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.d.edit') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.type(
			within(dialog).getByRole('textbox', { name: t('usr.d.phone') }),
			'call me'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.d.edit.save') }));
		await within(dialog).findByText(t('usr.d.edit.phoneInvalid'));
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Suspend"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		const dialog = await choose(canvasElement, 'suspend', NORMAL);
		// A reason is required: without one the form is not sent.
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.action.suspend') }));
		expect(canvas.queryByText(t('usr.status.suspended'))).toBeNull();
		expect(dialog).toHaveAttribute('open');
		await userEvent.selectOptions(
			within(dialog).getByRole('combobox', { name: new RegExp(t('usr.reason')) }),
			'investigation'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.action.suspend') }));
		await body(canvasElement).findByText(t('usr.toast.suspended', { name: nameOf(NORMAL) }));
		await canvas.findByText(t('usr.status.suspended'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="State changed meanwhile"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const dialog = await choose(canvasElement, 'suspend', NORMAL);
		await userEvent.selectOptions(
			within(dialog).getByRole('combobox', { name: new RegExp(t('usr.reason')) }),
			'other'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.action.suspend') }));
		await body(canvasElement).findByText(t('usr.error.conflict'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers({ lifecycleConflict: true })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Reactivated by someone else"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		const dialog = await choose(canvasElement, 'activate', SUSPENDED);
		await userEvent.selectOptions(
			within(dialog).getByRole('combobox', { name: new RegExp(t('usr.reason')) }),
			'appeal_approved'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.action.activate') }));
		// The API answers 400 "already active"; the page reads the user again and says so.
		await body(canvasElement).findByText(t('usr.error.conflict'));
		await canvas.findByText(t('usr.status.active'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers({ activatedMeanwhile: true })}
			userId={SUSPENDED}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Recent activity: too many events"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('usr.d.activity.tooMany'));
		// Asking again cannot help; the audit log can narrow the period.
		expect(canvas.queryByRole('button', { name: t('common.retry') })).toBeNull();
		await canvas.findByRole('button', { name: t('usr.d.activity.all') });
		await canvas.findByText(t('usr.d.methods'));
	}}
>
	{#snippet template()}
		<UserDetailPage
			client={createFakeAdminUsers({ activityIncomplete: true })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
			{onopenaudit}
		/>
	{/snippet}
</Story>

<Story
	name="Lock"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		const dialog = await choose(canvasElement, 'lock', NORMAL);
		await userEvent.selectOptions(
			within(dialog).getByRole('combobox', { name: new RegExp(t('usr.reason')) }),
			'suspicious_activity'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.action.lock') }));
		await canvas.findByText(t('usr.status.locked'));
		// The lock is in the user's recent activity, marked as an administrator's action.
		await canvas.findByText(t('uaud.byAdmin'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Reactivate"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		const dialog = await choose(canvasElement, 'activate', SUSPENDED);
		await userEvent.selectOptions(
			within(dialog).getByRole('combobox', { name: new RegExp(t('usr.reason')) }),
			'appeal_approved'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.action.activate') }));
		await canvas.findByText(t('usr.status.active'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={SUSPENDED}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Sign out everywhere"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.d.signOut') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.d.signOut') }));
		await body(canvasElement).findByText(t('usr.toast.signedOut', { name: nameOf(NORMAL) }));
		await canvas.findByText(t('usr.d.sessions.empty'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Sign out needs step-up"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.d.signOut') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.d.signOut') }));
		await body(canvasElement).findByText(t('usr.d.signOut.stepUp'));
		// Nothing was ended.
		await waitFor(() => expect(canvas.queryByText(t('usr.d.sessions.empty'))).toBeNull());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers({ stepUp: 'refused' })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Sign out declined"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('usr.d.signOut') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.d.signOut') }));
		await body(canvasElement).findByText(t('usr.d.signOut.cancelled'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers({ stepUp: 'declined' })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Delete"
	play={async ({ canvasElement }) => {
		ondeleted.mockClear();
		toast.dismissAll();
		const dialog = await choose(canvasElement, 'delete', NORMAL);
		await within(dialog).findByText(t('usr.delete.body'));
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.delete.confirm') }));
		await waitFor(() => expect(ondeleted).toHaveBeenCalledOnce());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers()}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Delete under legal hold"
	play={async ({ canvasElement }) => {
		ondeleted.mockClear();
		toast.dismissAll();
		const dialog = await choose(canvasElement, 'delete', NORMAL);
		await userEvent.click(within(dialog).getByRole('button', { name: t('usr.delete.confirm') }));
		await body(canvasElement).findByText(t('usr.error.legalHold'));
		expect(ondeleted).not.toHaveBeenCalled();
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<UserDetailPage
			client={createFakeAdminUsers({ legalHold: true })}
			userId={NORMAL}
			access={tenant}
			listHref="#users"
			{ondeleted}
		/>
	{/snippet}
</Story>
