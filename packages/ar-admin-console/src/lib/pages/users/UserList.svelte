<script lang="ts">
	import { untrack } from 'svelte';
	import { hasPermission, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import {
		CursorStaleError,
		type AdminUser,
		type AdminUsersClient,
		type AdminUsersPosition
	} from '#lib/api/admin-users.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { STATUS_LABEL, STATUS_TONE, createErrorOf, emailProblem, userLabel } from './user-model';

	/**
	 * Users → All users: the tenant's end users, a page at a time ("Load more"), found by exact
	 * email or user ID (the API cannot filter, sort or search partly where accounts are sharded).
	 * Admins with `admin:users:write` can add a user; a row opens the user. Admins without
	 * `admin:users:read` see that they cannot, nothing else.
	 */
	interface Props {
		client: AdminUsersClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** Rows per request; the API's default when omitted. */
		pageSize?: number;
		/** Opens a user's page. */
		onopen?: (userId: string) => void;
	}

	let { client, access, pageSize, onopen }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const canRead = $derived(hasPermission(who, 'admin:users:read'));
	const canWrite = $derived(hasPermission(who, 'admin:users:write'));

	let users = $state<AdminUser[]>([]);
	let next = $state<AdminUsersPosition | null>(null);
	let total = $state<number | undefined>(undefined);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let loadingMore = $state(false);
	let moreFailed = $state(false);

	/** What is typed, and the search it was confirmed as (Enter or clear). */
	let typed = $state('');
	let query = $state('');

	let generation = 0;
	async function load(): Promise<void> {
		const mine = ++generation;
		if (!canRead) {
			phase = 'forbidden';
			return;
		}
		phase = 'loading';
		loadingMore = false;
		moreFailed = false;
		try {
			const page = await client.list({ search: query || undefined, limit: pageSize });
			if (mine !== generation) return;
			users = page.users;
			next = page.next;
			total = page.total;
			phase = 'ready';
		} catch (error) {
			if (mine !== generation) return;
			phase = error instanceof ApiError && error.forbidden ? 'forbidden' : 'failed';
		}
	}

	async function loadMore(): Promise<void> {
		if (!next) return;
		const mine = generation;
		loadingMore = true;
		moreFailed = false;
		try {
			const page = await client.list({ search: query || undefined, limit: pageSize, at: next });
			if (mine !== generation) return;
			const seen = new Set(users.map((row) => row.id));
			users = [...users, ...page.users.filter((row) => !seen.has(row.id))];
			next = page.next;
			total = page.total ?? total;
		} catch (error) {
			if (mine !== generation) return;
			// The account shards changed while paging: the cursor is useless, start over once.
			if (error instanceof CursorStaleError) await load();
			else moreFailed = true;
		} finally {
			if (mine === generation) loadingMore = false;
		}
	}

	// The search (and who is looking) decides the list: read it again from the top when it changes.
	$effect(() => {
		void [query, canRead];
		untrack(load);
	});

	function clear(): void {
		typed = '';
		query = '';
	}

	// Add user
	let adding = $state(false);
	let busy = $state(false);
	let email = $state('');
	let name = $state('');
	let emailError = $state('');
	let formError = $state('');

	function openAdd(): void {
		email = '';
		name = '';
		emailError = '';
		formError = '';
		adding = true;
	}

	async function add(): Promise<void> {
		const problem = emailProblem(email);
		emailError = problem ? t(problem) : '';
		formError = '';
		if (problem) return;
		busy = true;
		try {
			const result = await client.create({ email, name });
			adding = false;
			if (result.status === 'created') {
				toast.success(t('usr.toast.created', { name: userLabel(result.user) }));
				if (onopen) onopen(result.user.id);
				else await load();
			} else {
				toast.success(t('usr.toast.pending'));
				await load();
			}
		} catch (error) {
			const { key, field } = createErrorOf(error);
			if (field === 'email') emailError = t(key);
			else formError = t(key);
		} finally {
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'user', label: t('usr.col.user') },
		{ key: 'status', label: t('usr.col.status'), width: '16%' },
		{ key: 'lastLogin', label: t('usr.col.lastLogin'), width: '22%' },
		{ key: 'created', label: t('usr.col.created'), width: '22%' }
	]);
</script>

<Page>
	<PageHeader title={t('nav.users.all')} description={t('usr.page.desc')}>
		{#snippet actions()}
			{#if canRead && canWrite}
				<Button variant="primary" icon="plus" onclick={openAdd}>{t('usr.add')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('usr.noAccess')} />
	{:else}
		<FilterBar results={phase === 'ready' ? total : undefined} active={!!query} onclear={clear}>
			{#snippet search()}
				<!-- An exact match means a partial address finds nothing, so a request goes out only on Enter or clear, not while typing. -->
				<SearchField
					label={t('usr.search')}
					placeholder={t('usr.search')}
					size="sm"
					delay={2_000_000_000}
					bind:value={typed}
					onsearch={(value) => (query = value)}
				/>
			{/snippet}
		</FilterBar>

		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'failed'}
			<EmptyState icon="warning" title={t('usr.loadFailed')} description={t('load.error.body')}>
				{#snippet action()}
					<Button onclick={load}>{t('common.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<Card title={t('usr.list.title')} description={t('usr.search.exact')} flush>
				<DataTable
					caption={t('usr.list.title')}
					{columns}
					rows={users}
					rowKey={(row) => row.id}
					onrowopen={onopen ? (row) => onopen(row.id) : undefined}
					rowOpenLabel={(row) => t('usr.row.open', { name: userLabel(row) })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'user'}
							{#if row.pii_status === 'deleted'}
								<span class="muted">{t('usr.piiDeleted')}</span>
								<span class="second"><code>{row.id}</code></span>
							{:else if row.name}
								<span class="name">{row.name}</span>
								{#if row.email}<span class="second"><bdi>{row.email}</bdi></span>{/if}
							{:else}
								<span class="name"><bdi>{row.email ?? row.id}</bdi></span>
							{/if}
						{:else if column.key === 'status'}
							<Badge tone={STATUS_TONE[row.lifecycle_state]} dot>
								{t(STATUS_LABEL[row.lifecycle_state])}
							</Badge>
						{:else if column.key === 'lastLogin'}
							{#if row.last_login_at}
								<DateTime value={row.last_login_at} stacked />
							{:else}
								<span class="muted">{t('usr.never')}</span>
							{/if}
						{:else if row.created_at}
							<DateTime value={row.created_at} stacked />
						{:else}
							<span class="muted">—</span>
						{/if}
					{/snippet}
					{#snippet empty()}
						{#if query}
							<EmptyState
								icon="search"
								title={t('usr.noMatch')}
								description={t('usr.noMatch.body')}
							/>
						{:else}
							<EmptyState icon="users" title={t('usr.empty')}>
								{#snippet action()}
									{#if canWrite}
										<Button variant="primary" icon="plus" onclick={openAdd}>{t('usr.add')}</Button>
									{/if}
								{/snippet}
							</EmptyState>
						{/if}
					{/snippet}
				</DataTable>
				{#if next || moreFailed}
					<div class="more">
						{#if moreFailed}
							<Callout tone="danger" live>{t('usr.moreFailed')}</Callout>
						{/if}
						{#if next}
							<Button size="sm" loading={loadingMore} onclick={loadMore}>{t('usr.more')}</Button>
						{/if}
					</div>
				{/if}
			</Card>
		{/if}
	{/if}
</Page>

<FormDialog
	open={adding}
	title={t('usr.new.title')}
	submitLabel={t('usr.new.submit')}
	{busy}
	error={formError}
	onsubmit={add}
	oncancel={() => (adding = false)}
>
	<TextField
		label={t('usr.new.email')}
		inputmode="email"
		dir="ltr"
		required
		maxlength={254}
		bind:value={email}
		error={emailError}
	/>
	<TextField label={t('usr.new.name')} maxlength={200} bind:value={name} />
</FormDialog>

<style>
	.name {
		display: block;
		font-weight: var(--fw-name);
	}

	.second {
		display: block;
		color: var(--text-muted);
		font-size: var(--fs-caption);
		line-height: var(--lh-body);
	}

	.muted {
		color: var(--text-muted);
	}

	.more {
		display: grid;
		justify-items: center;
		gap: var(--space-related);
		padding: var(--box-pad);
	}
</style>
