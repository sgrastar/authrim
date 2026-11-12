<script lang="ts">
	import { untrack } from 'svelte';
	import { userDetailAccess, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import type { AdminUserDetail, AdminUsersClient } from '#lib/api/admin-users.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import UserActivityCard from './UserActivityCard.svelte';
	import UserBasicCard from './UserBasicCard.svelte';
	import UserLifecycleDialog from './UserLifecycleDialog.svelte';
	import UserSessionsCard from './UserSessionsCard.svelte';
	import UserSignInMethods from './UserSignInMethods.svelte';
	import {
		STATUS_LABEL,
		STATUS_TONE,
		actionErrorKey,
		userLabel,
		type LifecycleKind
	} from './user-model';

	/**
	 * Users → All users → one user: who they are (editable profile), how they sign in, their
	 * active sessions, their latest activity, and what an admin may do with the account (suspend,
	 * lock, reactivate, delete). One page, no tabs: each section loads on its own, so one failing
	 * never blanks the page, and a section or action the admin cannot use is left out.
	 */
	interface Props {
		client: AdminUsersClient;
		userId: string;
		listHref: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** The user was deleted: back to the list. */
		ondeleted: () => void;
		/** Opens the audit log for this user. */
		onopenaudit?: (userId: string) => void;
		/** Override the zone the unlock time is typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { client, userId, listHref, access, ondeleted, onopenaudit, zone }: Props = $props();

	const can = $derived(userDetailAccess(access ?? adminAccess.current));

	let detail = $state<AdminUserDetail | null>(null);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	/** Bumped when the user changed here: the sessions and the activity are read again. */
	let refresh = $state(0);
	let lifecycle = $state<LifecycleKind | null>(null);
	let deleting = $state(false);
	let busy = $state(false);

	let generation = 0;
	async function load(quiet = false): Promise<void> {
		const mine = ++generation;
		if (!can.read) {
			phase = 'forbidden';
			return;
		}
		if (!quiet) phase = 'loading';
		try {
			const result = await client.get(userId);
			if (mine !== generation) return;
			detail = result;
			phase = 'ready';
		} catch (error) {
			if (mine !== generation) return;
			// What is on screen may be out of date (a change went through, the reload did not): it
			// goes, and the page offers to load again, so nothing is changed on top of it.
			if (quiet) toast.error(t('usr.loadFailed'));
			detail = null;
			phase =
				error instanceof ApiError && error.status === 404
					? 'notFound'
					: error instanceof ApiError && error.status === 403
						? 'forbidden'
						: 'failed';
		}
	}

	$effect(() => {
		void [userId, can.read];
		untrack(() => void load());
	});

	async function reload(): Promise<void> {
		lifecycle = null;
		refresh += 1;
		await load(true);
	}

	async function remove(): Promise<void> {
		if (!detail) return;
		const label = userLabel(detail.user);
		busy = true;
		try {
			await client.remove(userId);
			deleting = false;
			toast.success(t('usr.toast.deleted', { name: label }));
			ondeleted();
		} catch (error) {
			deleting = false;
			toast.error(t(actionErrorKey(error)));
		} finally {
			busy = false;
		}
	}

	const user = $derived(detail?.user ?? null);
	const deleted = $derived(user?.pii_status === 'deleted');
	const title = $derived(
		user
			? deleted
				? t('usr.piiDeleted')
				: (user.name ?? user.email ?? user.id)
			: t('nav.users.all')
	);

	const menuActions = $derived.by((): MenuAction[] => {
		if (!user) return [];
		const list: MenuAction[] = [];
		if (can.lifecycle && user.lifecycle_state === 'active') {
			list.push(
				{ label: t('usr.action.suspend'), icon: 'close', onselect: () => (lifecycle = 'suspend') },
				{ label: t('usr.action.lock'), icon: 'lock', onselect: () => (lifecycle = 'lock') }
			);
		}
		if (
			can.lifecycle &&
			(user.lifecycle_state === 'suspended' || user.lifecycle_state === 'locked')
		) {
			list.push({
				label: t('usr.action.activate'),
				icon: 'checkCircle',
				onselect: () => (lifecycle = 'activate')
			});
		}
		if (can.delete) {
			list.push({
				label: t('usr.action.delete'),
				icon: 'trash',
				danger: true,
				onselect: () => (deleting = true)
			});
		}
		return list;
	});
</script>

<Page>
	<PageHeader {title}>
		{#snippet back()}
			<BackLink href={listHref}>{t('usr.back')}</BackLink>
		{/snippet}
		{#snippet badges()}
			{#if user}
				<Badge tone={STATUS_TONE[user.lifecycle_state]} dot>
					{t(STATUS_LABEL[user.lifecycle_state])}
				</Badge>
			{/if}
		{/snippet}
		{#snippet actions()}
			{#if user && menuActions.length > 0}
				<ActionMenu label={t('usr.d.actions', { name: title })} actions={menuActions} />
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="users" title={t('usr.d.notFound')}>
			{#snippet action()}
				<Button href={listHref}>{t('usr.back')}</Button>
			{/snippet}
		</EmptyState>
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('usr.noAccess')} />
	{:else if phase === 'failed' || !detail || !user}
		<EmptyState icon="warning" title={t('usr.loadFailed')} description={t('load.error.body')}>
			{#snippet action()}
				<Button onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if detail.restricted}
			<Callout>{t('usr.d.restricted')}</Callout>
		{/if}
		<UserBasicCard
			{client}
			{user}
			canEdit={can.edit && !deleted && !detail.restricted}
			onsaved={reload}
		/>
		{#if !detail.restricted}
			<UserSignInMethods passkeys={detail.passkeys} totp={detail.totp} />
		{/if}
		{#if can.sessions}
			<UserSessionsCard
				{client}
				{userId}
				label={userLabel(user)}
				canRevoke={can.revokeSessions}
				{refresh}
			/>
		{/if}
		<UserActivityCard {client} {userId} {onopenaudit} {refresh} />
	{/if}
</Page>

{#if user}
	<UserLifecycleDialog
		{client}
		{user}
		kind={lifecycle}
		{zone}
		oncancel={() => (lifecycle = null)}
		ondone={reload}
		onconflict={reload}
	/>
	<ConfirmDialog
		open={deleting}
		title={t('usr.delete.title', { name: userLabel(user) })}
		body={t('usr.delete.body')}
		confirmLabel={t('usr.delete.confirm')}
		tone="danger"
		{busy}
		onconfirm={remove}
		oncancel={() => (deleting = false)}
	/>
{/if}
