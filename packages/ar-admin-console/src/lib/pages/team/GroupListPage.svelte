<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import {
		GROUP_KEY_PATTERN,
		type AdminGroupSummary,
		type AdminGroupsClient
	} from '#lib/api/admin-groups.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { teamErrorKey } from './team-errors';

	/**
	 * Settings → Administrator groups: the tenant's groups, how many members and roles each has.
	 * A row opens its group; "Create group" names a new one (a display name and a key set once).
	 */
	interface Props {
		client: AdminGroupsClient;
		access: TeamAccess;
		onopen: (groupId: string) => void;
	}

	let { client, access, onopen }: Props = $props();

	let groups = $state<AdminGroupSummary[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');

	let creating = $state(false);
	let busy = $state(false);
	let name = $state('');
	let key = $state('');
	let keyTouched = $state(false);
	let description = $state('');
	let error = $state('');

	async function load() {
		phase = 'loading';
		try {
			groups = await client.list();
			phase = 'ready';
		} catch (failure) {
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	/** A key suggested from the name until the admin types one (letters and digits it has). */
	const suggestKey = (text: string) =>
		text
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/^[-_]+|-+$/g, '')
			.slice(0, 64);

	function openCreate() {
		name = '';
		key = '';
		keyTouched = false;
		description = '';
		error = '';
		creating = true;
	}

	async function create() {
		if (!name.trim()) {
			error = t('tg.new.nameRequired');
			return;
		}
		if (!GROUP_KEY_PATTERN.test(key.trim())) {
			error = t('tg.new.keyInvalid');
			return;
		}
		busy = true;
		error = '';
		try {
			const group = await client.create({ group_key: key, display_name: name, description });
			creating = false;
			toast.success(t('tg.toast.created', { name: group.display_name }));
			onopen(group.id);
		} catch (failure) {
			error = t(teamErrorKey(failure, 'tm.error.generic', 'tg.error.keyTaken'));
		} finally {
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'group', label: t('tg.list.col.group') },
		{ key: 'members', label: t('tg.list.col.members'), width: '14%' },
		{ key: 'roles', label: t('tg.list.col.roles'), width: '14%' },
		{ key: 'updated', label: t('tg.list.col.updated'), width: '22%' }
	]);
</script>

<Page>
	<PageHeader title={t('nav.set.teamGroups')} description={t('tg.page.desc')}>
		{#snippet actions()}
			{#if access.groupsEdit}
				<Button variant="primary" icon="plus" onclick={openCreate}>{t('tg.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tg.list.noAccess')} />
	{:else}
		<Card title={t('tg.list.title')} flush>
			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'failed'}
				<EmptyState icon="warningCircle" title={t('tg.list.loadFailed')}>
					{#snippet action()}
						<Button size="sm" onclick={load}>{t('common.retry')}</Button>
					{/snippet}
				</EmptyState>
			{:else}
				<DataTable
					caption={t('tg.list.title')}
					{columns}
					rows={groups}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('tg.list.open', { name: row.display_name })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'group'}
							<CellText title={row.display_name} description={row.description ?? row.group_key} />
						{:else if column.key === 'members'}
							{row.member_count}
						{:else if column.key === 'roles'}
							{row.grant_count}
						{:else}
							<DateTime value={row.updated_at} stacked />
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="users"
							title={t('tg.list.empty')}
							description={access.groupsEdit ? t('tg.list.emptyBody') : undefined}
						/>
					{/snippet}
				</DataTable>
			{/if}
		</Card>
	{/if}
</Page>

<FormDialog
	open={creating}
	title={t('tg.new.title')}
	submitLabel={t('tg.new.submit')}
	{busy}
	{error}
	onsubmit={create}
	oncancel={() => (creating = false)}
>
	<TextField
		label={t('tg.new.name')}
		required
		maxlength={100}
		bind:value={name}
		oninput={() => {
			if (!keyTouched) key = suggestKey(name);
		}}
	/>
	<TextField
		label={t('tg.new.key')}
		required
		maxlength={64}
		hint={t('tg.new.keyHint')}
		bind:value={key}
		oninput={() => (keyTouched = true)}
	/>
	<TextArea label={t('tg.new.description')} maxlength={500} bind:value={description} />
</FormDialog>
