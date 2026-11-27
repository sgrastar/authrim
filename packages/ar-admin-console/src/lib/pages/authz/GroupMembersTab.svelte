<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import type {
		EndUserGroupDetail,
		EndUserGroupsClient,
		GroupMember
	} from '#lib/api/end-user-groups.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { refusalText } from './authz-errors';
	import { SOURCE_LABEL, memberLabel } from './group-model';
	import { userSearch } from './user-picker';

	/**
	 * Who is in a group: one row per membership, whatever its source (manual, SCIM, a rule, the
	 * dynamic rule, an invitation), and whether it grants now. "Add members" adds manual
	 * memberships one by one (each is its own change, checked by the API: in a group that carries
	 * roles it gives those roles); a manual row's menu ends it. Rows from other sources are
	 * changed at their source.
	 */
	interface Props {
		client: EndUserGroupsClient;
		users: Pick<AdminUsersClient, 'list'>;
		group: EndUserGroupDetail;
		access: AuthzAccess;
		/** Opens a user's page. */
		onopenuser?: (userId: string) => void;
		onchanged: () => void;
		pageSize?: number;
	}

	let { client, users, group, access, onopenuser, onchanged, pageSize = 50 }: Props = $props();

	let rows = $state<GroupMember[]>([]);
	let nextPage = $state<number | null>(null);
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let loadingMore = $state(false);
	let adding = $state(false);
	let picked = $state<PickerItem[]>([]);
	let removing = $state<GroupMember | null>(null);
	let busy = $state(false);
	let error = $state('');

	async function load() {
		phase = 'loading';
		try {
			const result = await client.members(group.id, { page: 1, limit: pageSize });
			rows = result.items;
			nextPage = result.hasNext ? result.page + 1 : null;
			phase = 'ready';
		} catch {
			phase = 'failed';
		}
	}

	async function loadMore() {
		// One request at a time: a second click while one runs would read the same page twice.
		if (!nextPage || loadingMore) return;
		loadingMore = true;
		try {
			const result = await client.members(group.id, { page: nextPage, limit: pageSize });
			rows = [...rows, ...result.items];
			nextPage = result.hasNext ? result.page + 1 : null;
		} catch {
			toast.error(t('grp.members.loadFailed'));
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		void group.id;
		untrack(() => void load());
	});

	// The API says whether this admin may change who is in this group (its roles and its parents'
	// against their grant ceiling); an older API that does not say leaves it to the permission.
	const editable = $derived(access.groupsWrite && (group.can_manage_membership ?? true));
	const search = $derived(
		userSearch(users, {
			typedAsId: t('az.picker.typedId'),
			searchRefused: t('az.picker.searchRefused'),
			canSearch: access.usersRead,
			exclude: () =>
				new Set(rows.filter((row) => row.source === 'manual').map((row) => row.subject_id))
		})
	);

	function openAdd() {
		picked = [];
		error = '';
		adding = true;
	}

	async function add() {
		if (picked.length === 0) {
			error = t('grp.members.add.none');
			return;
		}
		busy = true;
		error = '';
		let added = 0;
		try {
			for (const item of picked) {
				await client.addMember(group.id, item.value);
				added += 1;
			}
			adding = false;
			toast.success(t('grp.toast.membersAdded', { count: added }));
			await load();
			onchanged();
		} catch (failure) {
			const stopped = picked[added];
			picked = picked.slice(added);
			const reason = refusalText(failure, t);
			error =
				added > 0
					? t('grp.members.addedSome', { added, name: stopped?.label ?? '', reason })
					: reason;
			// Some were added: the list and the group's own counts are read again.
			if (added > 0) {
				await load();
				onchanged();
			}
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const member = removing;
		if (!member) return;
		busy = true;
		try {
			await client.removeMember(group.id, member.subject_id);
			toast.success(t('grp.toast.memberRemoved', { name: memberLabel(member) }));
			await load();
			onchanged();
		} catch (failure) {
			toast.error(refusalText(failure, t));
		} finally {
			removing = null;
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'user', label: t('grp.members.col.user') },
		{ key: 'source', label: t('grp.members.col.source'), width: '18%' },
		{ key: 'effective', label: t('grp.members.col.effective'), width: '16%' },
		{ key: 'ends', label: t('grp.members.col.ends'), width: '20%' },
		...(editable
			? [
					{
						key: 'actions',
						label: t('grp.members.col.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Card title={t('grp.members')} description={t('grp.members.desc')} flush>
	{#snippet actions()}
		{#if editable}
			<Button size="sm" icon="userPlus" onclick={openAdd}>{t('grp.members.add')}</Button>
		{/if}
	{/snippet}
	{#if group.managed}
		<Callout icon="info">{t('grp.members.dynamicNote')}</Callout>
	{/if}
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('grp.members.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<DataTable
			caption={t('grp.members')}
			{columns}
			{rows}
			rowKey={(row) => `${row.subject_id}:${row.source}:${row.source_ref ?? ''}`}
			onrowopen={onopenuser && ((row) => onopenuser(row.subject_id))}
			rowOpenLabel={(row) => t('grp.members.open', { name: memberLabel(row) })}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'user'}
					<CellText
						title={memberLabel(row)}
						description={row.name
							? (row.email ?? row.subject_id)
							: row.email
								? row.subject_id
								: undefined}
					/>
				{:else if column.key === 'source'}
					<Badge tone={row.source === 'manual' ? 'neutral' : 'info'}
						>{t(SOURCE_LABEL[row.source])}</Badge
					>
				{:else if column.key === 'effective'}
					{#if row.effective}
						<Badge tone="success" dot>{t('grp.members.effective')}</Badge>
					{:else}
						<Badge dot>{t('grp.members.notEffective')}</Badge>
					{/if}
				{:else if column.key === 'ends'}
					{#if row.expires_at}
						<DateTime value={row.expires_at} stacked />
					{:else if row.stale_after}
						<span class="muted">{t('grp.members.checkedUntil')}</span>
						<DateTime value={row.stale_after} stacked />
					{:else}
						<span class="muted">{t('grp.members.noEnd')}</span>
					{/if}
				{:else if row.source === 'manual'}
					<ActionMenu
						size="sm"
						label={t('grp.members.col.actions', { name: memberLabel(row) })}
						actions={[
							{
								label: t('grp.members.remove'),
								icon: 'trash',
								danger: true,
								disabled: busy,
								onselect: () => (removing = row)
							}
						]}
					/>
				{/if}
			{/snippet}
			{#snippet empty()}
				<EmptyState icon="users" title={t('grp.members.empty')} />
			{/snippet}
		</DataTable>
		{#if nextPage}
			<div class="more">
				<Button size="sm" loading={loadingMore} onclick={loadMore}>{t('grp.members.more')}</Button>
			</div>
		{/if}
	{/if}
</Card>

<FormDialog
	open={adding}
	title={t('grp.members.add.title', { name: group.display_name })}
	description={group.roles.length || group.parent_chain.length
		? t('grp.members.add.descRoles')
		: t('grp.members.add.desc')}
	submitLabel={t('grp.members.add.submit')}
	{busy}
	{error}
	onsubmit={add}
	oncancel={() => (adding = false)}
>
	<EntityPicker
		label={t('grp.members.add.pick')}
		placeholder={t('az.picker.placeholder')}
		multiple
		{search}
		bind:items={picked}
	/>
</FormDialog>

<ConfirmDialog
	open={removing !== null}
	title={t('grp.members.remove.title', { name: removing ? memberLabel(removing) : '' })}
	body={t('grp.members.remove.body')}
	confirmLabel={t('grp.members.remove')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (removing = null)}
/>

<style>
	.muted {
		color: var(--text-muted);
	}

	.more {
		padding: var(--box-pad);
	}
</style>
