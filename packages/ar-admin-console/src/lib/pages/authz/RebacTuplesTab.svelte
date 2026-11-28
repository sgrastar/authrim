<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { EndUserGroupsClient } from '#lib/api/end-user-groups.js';
	import type { EndUserRebacClient, RebacTuple, TupleInput } from '#lib/api/end-user-rebac.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Pagination from '#lib/ui/patterns/Pagination.svelte';
	import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { rebacRefusalText, subjectOf } from './rebac-model';
	import TupleCreateDialog from './TupleCreateDialog.svelte';
	import { groupSearch, userSearch } from './user-picker';

	/**
	 * Relationship tuples: who has which relation on which object. Filtered by the object's type,
	 * the relation and the subject's id. "Add tuple" writes one (a user, every member of a group,
	 * or an object edge a definition declares); a row's menu deletes it. The list leaves out what
	 * the API cannot list (members of a group are shown as the group, never as its members).
	 */
	interface Props {
		client: EndUserRebacClient;
		users: Pick<AdminUsersClient, 'list'>;
		groups: Pick<EndUserGroupsClient, 'list'>;
		access: AuthzAccess;
		/** The object types the definitions use. */
		objectTypes: readonly string[];
		pageSize?: number;
	}

	let { client, users, groups, access, objectTypes, pageSize = 20 }: Props = $props();

	let tuples = $state<RebacTuple[]>([]);
	let total = $state(0);
	let omitted = $state(false);
	let computedOmitted = $state(false);
	let page = $state(1);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let type = $state('');
	let relation = $state('');
	let subject = $state('');
	let adding = $state(false);
	let removing = $state<RebacTuple | null>(null);
	let busy = $state(false);

	let generation = 0;
	async function load() {
		const mine = ++generation;
		phase = 'loading';
		try {
			const result = await client.listTuples({
				object_type: type || undefined,
				relation: relation || undefined,
				subject_id: subject || undefined,
				page,
				limit: pageSize
			});
			if (mine !== generation) return;
			tuples = result.items;
			total = result.total;
			omitted = result.usersetOmitted;
			computedOmitted = result.computedOmitted;
			phase = 'ready';
		} catch (failure) {
			if (mine !== generation) return;
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void [type, relation, subject, page];
		untrack(() => void load());
	});

	function clear() {
		type = '';
		relation = '';
		subject = '';
		page = 1;
	}

	const searchUsers = $derived(
		userSearch(users, {
			typedAsId: t('az.picker.typedId'),
			searchRefused: t('az.picker.searchRefused'),
			canSearch: access.usersRead
		})
	);
	const searchGroups = $derived(
		groupSearch(groups, {
			typedAsId: t('az.picker.groupTypedId'),
			searchRefused: t('az.picker.groupSearchRefused')
		})
	);

	async function add(input: TupleInput) {
		await client.createTuple(input);
		adding = false;
		toast.success(t('rb.tuple.toast.added'));
		page = 1;
		await load();
	}

	async function remove() {
		const target = removing;
		if (!target) return;
		busy = true;
		try {
			await client.removeTuple(target.id);
			removing = null;
			toast.success(t('rb.tuple.toast.removed'));
			await load();
		} catch (failure) {
			removing = null;
			toast.error(rebacRefusalText(failure, 'tuple', t));
		} finally {
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'subject', label: t('rb.tuple.col.subject') },
		{ key: 'relation', label: t('rb.tuple.col.relation'), width: '14%' },
		{ key: 'object', label: t('rb.tuple.col.object') },
		{ key: 'ends', label: t('rb.tuple.col.ends'), width: '16%' },
		...(access.rebacDelete
			? [{ key: 'actions', label: t('rb.tuple.col.actions'), width: '56px', hideLabel: true }]
			: [])
	]);
	const typeOptions = $derived([
		{ value: '', label: t('rb.filter.allTypes') },
		...objectTypes.map((name) => ({ value: name, label: name }))
	]);
	const KIND_LABEL = {
		user: 'rb.tuple.kind.user',
		groupMembers: 'rb.tuple.kind.groupMembers',
		group: 'rb.tuple.kind.groupPlain',
		object: 'rb.tuple.kind.object'
	} as const;
	const label = (row: RebacTuple) =>
		t('rb.tuple.rowLabel', { subject: subjectOf(row).label, relation: row.relation });
</script>

<Callout icon="info">
	{t('rb.tuple.note')}
	{#if omitted}{t('rb.tuple.omitted')}{/if}
	{#if computedOmitted}{t('rb.tuple.computedOmitted')}{/if}
</Callout>

<FilterBar
	results={phase === 'ready' ? total : undefined}
	active={Boolean(type || relation || subject)}
	onclear={clear}
>
	{#snippet search()}
		<SearchField
			size="sm"
			label={t('rb.filter.subject')}
			placeholder={t('rb.filter.subject')}
			value={subject}
			onsearch={(value) => {
				subject = value.trim();
				page = 1;
			}}
		/>
	{/snippet}
	<Select
		size="sm"
		label={t('rb.filter.objectType')}
		options={typeOptions}
		bind:value={() => type, (value) => ((type = value), (page = 1))}
	/>
	<SearchField
		size="sm"
		label={t('rb.filter.relation')}
		placeholder={t('rb.filter.relation')}
		value={relation}
		onsearch={(value) => {
			relation = value.trim();
			page = 1;
		}}
	/>
</FilterBar>

<Card title={t('rb.tuple.title')} flush>
	{#snippet actions()}
		{#if access.rebacWrite}
			<Button size="sm" variant="primary" icon="plus" onclick={() => (adding = true)}>
				{t('rb.tuple.add')}
			</Button>
		{/if}
	{/snippet}
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('rb.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('rb.tuple.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<DataTable
			caption={t('rb.tuple.title')}
			{columns}
			rows={tuples}
			rowKey={(row) => row.id}
			scrollFocusable={!access.rebacDelete}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'subject'}
					{@const who = subjectOf(row)}
					<span class="who">
						<Badge tone={who.kind === 'user' ? 'neutral' : 'info'}>{t(KIND_LABEL[who.kind])}</Badge>
						<code>{who.label}</code>
						{#if row.inactiveLegacy}
							<Badge tone="warning">{t('rb.tuple.inactiveLegacy')}</Badge>
						{/if}
					</span>
				{:else if column.key === 'relation'}
					<code>{row.relation}</code>
				{:else if column.key === 'object'}
					<code>{row.to_type}:{row.to_id}</code>
				{:else if column.key === 'ends'}
					{#if row.expires_at !== null}
						<DateTime value={row.expires_at} stacked />
						{#if row.expires_at <= Date.now()}
							<Badge tone="warning">{t('rb.tuple.expired')}</Badge>
						{/if}
					{:else}
						<span class="muted">{t('rb.tuple.noEnd')}</span>
					{/if}
				{:else}
					<ActionMenu
						size="sm"
						label={t('rb.tuple.actions', { name: label(row) })}
						actions={[
							{
								label: t('rb.tuple.remove'),
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
				<EmptyState
					icon="link"
					title={type || relation || subject ? t('rb.tuple.noMatch') : t('rb.tuple.empty')}
					description={access.rebacWrite && !(type || relation || subject)
						? t('rb.tuple.emptyBody')
						: undefined}
				/>
			{/snippet}
		</DataTable>
		{#if total > pageSize}
			<Pagination {total} {pageSize} {page} onchange={(next) => (page = next)} />
		{/if}
	{/if}
</Card>

<TupleCreateDialog
	open={adding}
	{objectTypes}
	{searchUsers}
	{searchGroups}
	onsubmit={add}
	oncancel={() => (adding = false)}
/>

<ConfirmDialog
	open={removing !== null}
	title={t('rb.tuple.remove.title')}
	body={removing
		? t('rb.tuple.remove.body', {
				subject: subjectOf(removing).label,
				relation: removing.relation,
				object: `${removing.to_type}:${removing.to_id}`
			})
		: ''}
	confirmLabel={t('rb.tuple.remove')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (removing = null)}
/>

<style>
	.who {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.muted {
		color: var(--text-muted);
	}
</style>
