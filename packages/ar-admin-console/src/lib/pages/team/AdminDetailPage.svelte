<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import type { AdminDetail, AdminTeamClient } from '#lib/api/admin-team.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import AdminRoles from './AdminRoles.svelte';
	import { teamErrorKey } from './team-errors';
	import { adminLabel, isLocked } from './team-model';

	/**
	 * Settings → Administrators → one administrator: who they are (name and address, editable),
	 * their state (suspend, reactivate, unlock), the roles they hold and where each comes from,
	 * their admin groups and passkeys, and deleting them.
	 */
	interface Props {
		client: AdminTeamClient;
		adminId: string;
		access: TeamAccess;
		/** The tenant the page is in (the administrator's home). */
		tenantId: string;
		listHref: string;
		/** A group's page, once there is one. */
		groupHref?: (groupId: string) => string;
		/** The administrator was deleted: back to the list. */
		ondeleted: () => void;
		/** Override the zone role ends are typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { client, adminId, access, tenantId, listHref, groupHref, ondeleted, zone }: Props = $props();

	type Change = 'suspend' | 'activate' | 'unlock';

	let admin = $state<AdminDetail | null>(null);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	/** Roles for every tenant can be given here: the administrator belongs to the default tenant. */
	let globalHere = $state(false);
	let busy = $state(false);
	let pending = $state<Change | null>(null);
	let editing = $state(false);
	let name = $state('');
	let email = $state('');
	let editError = $state('');

	async function load(quiet = false) {
		if (!quiet) phase = 'loading';
		try {
			const [detail, home] = await Promise.all([
				client.getAdmin(adminId),
				access.global ? client.defaultTenantId() : Promise.resolve(null)
			]);
			admin = detail;
			// Only where the default tenant is known to be this one; otherwise the API would refuse.
			globalHere = access.global && home === tenantId;
			phase = 'ready';
		} catch (error) {
			// What is on screen may be out of date (a change went through, the reload did not): it
			// goes, and the page offers to load again, so nothing is changed on top of it.
			if (quiet) toast.error(t('tm.d.loadFailed'));
			admin = null;
			phase =
				error instanceof ApiError && error.status === 404
					? 'notFound'
					: error instanceof ApiError && error.status === 403
						? 'forbidden'
						: 'failed';
		}
	}

	$effect(() => {
		void adminId;
		untrack(() => void load());
	});

	const DONE: Record<Change, MessageKey> = {
		suspend: 'tm.toast.suspended',
		activate: 'tm.toast.activated',
		unlock: 'tm.toast.unlocked'
	};

	async function confirmChange() {
		if (!pending || !admin) return;
		const change = pending;
		busy = true;
		try {
			await client[change](admin.id);
			toast.success(t(DONE[change], { name: adminLabel(admin) }));
			await load(true);
		} catch (error) {
			toast.error(t(teamErrorKey(error)));
		} finally {
			pending = null;
			busy = false;
		}
	}

	function openEdit() {
		if (!admin) return;
		name = admin.name ?? '';
		email = admin.email;
		editError = '';
		editing = true;
	}

	async function save() {
		if (!admin) return;
		if (!email.trim()) {
			editError = t('tm.new.emailRequired');
			return;
		}
		if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
			editError = t('tm.new.emailInvalid');
			return;
		}
		busy = true;
		editError = '';
		try {
			await client.updateAdmin(admin.id, { name, email });
			editing = false;
			toast.success(t('tm.toast.saved'));
			await load(true);
		} catch (error) {
			editError = t(teamErrorKey(error));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!admin) return;
		const label = adminLabel(admin);
		try {
			await client.deleteAdmin(admin.id);
		} catch (error) {
			toast.error(t(teamErrorKey(error)));
			return;
		}
		toast.success(t('tm.toast.deleted', { name: label }));
		ondeleted();
	}

	const CONFIRM: Record<Change, { title: MessageKey; body: MessageKey; label: MessageKey }> = {
		suspend: { title: 'tm.suspend.title', body: 'tm.suspend.body', label: 'tm.action.suspend' },
		activate: { title: 'tm.activate.title', body: 'tm.activate.body', label: 'tm.action.activate' },
		unlock: { title: 'tm.unlock.title', body: 'tm.unlock.body', label: 'tm.action.unlock' }
	};
	const shown = $derived(CONFIRM[pending ?? 'suspend']);
</script>

<Page>
	<PageHeader title={admin ? adminLabel(admin) : t('set.page.team')}>
		{#snippet back()}
			<BackLink href={listHref}>{t('tm.d.back')}</BackLink>
		{/snippet}
		{#snippet badges()}
			{#if admin}
				{#if isLocked(admin)}
					<Badge tone="danger" dot>{t('tm.status.locked')}</Badge>
				{:else if admin.status === 'suspended'}
					<Badge tone="warning" dot>{t('tm.status.suspended')}</Badge>
				{:else}
					<Badge tone="success" dot>{t('tm.status.active')}</Badge>
				{/if}
			{/if}
		{/snippet}
		{#snippet actions()}
			{#if admin && access.manage}
				{#if isLocked(admin)}
					<Button icon="lock" disabled={busy} onclick={() => (pending = 'unlock')}>
						{t('tm.action.unlock')}
					</Button>
				{/if}
				{#if admin.status === 'suspended'}
					<Button icon="checkCircle" disabled={busy} onclick={() => (pending = 'activate')}>
						{t('tm.action.activate')}
					</Button>
				{:else}
					<Button icon="close" disabled={busy} onclick={() => (pending = 'suspend')}>
						{t('tm.action.suspend')}
					</Button>
				{/if}
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="users" title={t('tm.d.notFound')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tm.admins.noAccess')} />
	{:else if phase === 'failed' || !admin}
		<EmptyState icon="warningCircle" title={t('tm.d.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<Card title={t('tm.d.profile')}>
			{#snippet actions()}
				{#if access.edit}
					<Button size="sm" icon="pencil" onclick={openEdit}>{t('tm.d.edit')}</Button>
				{/if}
			{/snippet}
			<DetailList columns={2} ruled>
				<DetailItem label={t('tm.d.email')}>{admin.email}</DetailItem>
				<DetailItem label={t('tm.d.name')}>{admin.name ?? t('tm.d.noName')}</DetailItem>
				<DetailItem label={t('tm.d.mfa')}>
					{admin.mfa_enabled ? t('tm.mfa.on') : t('tm.mfa.off')}
				</DetailItem>
				<DetailItem label={t('tm.d.lastLogin')}>
					{#if admin.last_login_at}
						<DateTime value={admin.last_login_at} />
					{:else}
						{t('tm.admins.never')}
					{/if}
				</DetailItem>
				<DetailItem label={t('tm.d.created')}><DateTime value={admin.created_at} /></DetailItem>
			</DetailList>
		</Card>

		<AdminRoles
			{client}
			{admin}
			{access}
			{globalHere}
			{groupHref}
			{zone}
			onchanged={() => load(true)}
		/>

		<Card title={t('tm.d.groups')}>
			{#if admin.groups.length === 0}
				<p class="muted">{t('tm.d.groups.empty')}</p>
			{:else}
				<ul class="plain">
					{#each admin.groups as group (group.id)}
						<li>
							{#if groupHref}
								<Link href={groupHref(group.id)}>{group.display_name}</Link>
							{:else}
								<span>{group.display_name}</span>
							{/if}
							<span class="muted">{group.group_key}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>

		<Card title={t('tm.d.passkeys')}>
			{#if admin.passkeys.length === 0}
				<p class="muted">{t('tm.d.passkeys.empty')}</p>
			{:else}
				<ul class="plain">
					{#each admin.passkeys as passkey (passkey.id)}
						<li>
							<span>{passkey.device_name ?? passkey.provider ?? t('tm.d.passkey.unnamed')}</span>
							<span class="muted">
								{t('tm.d.passkey.created')}
								<DateTime value={passkey.created_at} style="date" />
							</span>
							<span class="muted">
								{t('tm.d.passkey.used')}
								{#if passkey.last_used_at}
									<DateTime value={passkey.last_used_at} style="date" />
								{:else}
									{t('tm.d.passkey.unused')}
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>

		{#if access.delete}
			<DangerZone
				title={t('tm.d.delete.title')}
				description={t('tm.d.delete.desc')}
				actionLabel={t('tm.d.delete.action')}
				confirmTitle={t('tm.d.delete.confirmTitle', { name: adminLabel(admin) })}
				confirmBody={t('tm.d.delete.confirmBody')}
				onconfirm={remove}
			/>
		{/if}
	{/if}
</Page>

<ConfirmDialog
	open={pending !== null}
	title={t(shown.title, { name: admin ? adminLabel(admin) : '' })}
	body={t(shown.body)}
	confirmLabel={t(shown.label)}
	tone={pending === 'suspend' ? 'danger' : 'default'}
	{busy}
	onconfirm={confirmChange}
	oncancel={() => (pending = null)}
/>

<FormDialog
	open={editing}
	title={t('tm.d.edit.title')}
	submitLabel={t('tm.d.edit.save')}
	{busy}
	error={editError}
	onsubmit={save}
	oncancel={() => (editing = false)}
>
	<TextField label={t('tm.d.name')} maxlength={200} bind:value={name} />
	<TextField
		label={t('tm.d.email')}
		type="email"
		required
		maxlength={254}
		hint={t('tm.d.edit.emailHint')}
		bind:value={email}
	/>
</FormDialog>

<style>
	.plain {
		display: grid;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.plain li {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		align-items: baseline;
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
	}
</style>
