<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		CheckApiKey,
		CheckApiKeyInput,
		CheckApiKeysClient
	} from '#lib/api/check-api-keys.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { refusalText } from '#lib/pages/authz/authz-errors.js';
	import CheckApiKeyCreateDialog from './CheckApiKeyCreateDialog.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Pagination from '#lib/ui/patterns/Pagination.svelte';
	import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SecretField from '#lib/ui/primitives/SecretField.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';

	/**
	 * The Check API keys of the tenant: which app's backend each belongs to, what it may ask, and
	 * whether it still works. A key can be made here (its secret is shown once, in a panel above the
	 * list, and cannot be read again) and revoked. Revoking stays possible while the platform has
	 * machine credentials off; making a key does not.
	 */
	interface Props {
		client: CheckApiKeysClient;
		tenantId: string;
		/** May list the keys (`admin:security:read`). */
		canList?: boolean;
		/** May revoke (`admin:security:write`; the platform's capability switch does not apply). */
		canRevoke: boolean;
		/** May make a key (`admin:security:write`, machine credentials on). */
		canCreate?: boolean;
		/** The platform has machine credentials off: no new key can be made for now. */
		capabilityOff?: boolean;
		pageSize?: number;
		/** The time an end is measured against (tests); now otherwise. */
		now?: number;
	}

	let {
		client,
		tenantId,
		canList = true,
		canRevoke,
		canCreate = false,
		capabilityOff = false,
		pageSize = 20,
		now
	}: Props = $props();

	let keys = $state<CheckApiKey[]>([]);
	let page = $state(1);
	let total = $state(0);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>(
		untrack(() => (canList ? 'loading' : 'forbidden'))
	);
	let revoking = $state<CheckApiKey | null>(null);
	let busy = $state(false);
	let creating = $state(false);
	/** The key just made and its secret, kept until the admin says it is saved. */
	let created = $state<{ id: number; name: string; secret: string | null } | null>(null);
	let createdCount = 0;

	/** Which list request is the latest: an older answer, or one after listing was refused, is dropped. */
	let generation = 0;

	async function load() {
		if (!canList) return;
		const mine = ++generation;
		phase = 'loading';
		try {
			const result = await client.list(page, pageSize);
			if (mine !== generation || !canList) return;
			keys = result.items;
			total = result.total;
			phase = 'ready';
		} catch (failure) {
			if (mine !== generation || !canList) return;
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		const listable = canList;
		void page;
		untrack(() => {
			if (!listable) {
				generation++;
				keys = [];
				total = 0;
				phase = 'forbidden';
			} else void load();
		});
	});

	/** Active, but past its end: the Check API no longer takes it. */
	const expired = (key: CheckApiKey) =>
		key.is_active && key.expires_at !== null && key.expires_at <= (now ?? Date.now());

	async function create(input: CheckApiKeyInput) {
		const made = await client.create(input);
		created = { id: ++createdCount, name: made.key.name, secret: made.api_key };
		creating = false;
		page = 1;
		await load();
	}

	async function revoke() {
		const key = revoking;
		if (!key) return;
		busy = true;
		try {
			await client.revoke(key.id);
			toast.success(t('az.keys.toast.revoked', { name: key.name }));
			await load();
		} catch (failure) {
			toast.error(refusalText(failure, t));
		} finally {
			revoking = null;
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'key', label: t('az.keys.col.key') },
		{ key: 'operations', label: t('az.keys.col.operations'), width: '20%' },
		{ key: 'state', label: t('az.keys.col.state'), width: '14%' },
		{ key: 'created', label: t('az.keys.col.created'), width: '20%' },
		...(canRevoke
			? [
					{
						key: 'actions',
						label: t('az.keys.col.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

{#if phase !== 'forbidden' || canCreate}
	<Card title={t('az.keys.title')} description={t('az.keys.desc')} flush>
		{#snippet actions()}
			{#if canCreate || capabilityOff}
				<Button
					size="sm"
					disabled={!canCreate || created !== null}
					onclick={() => (creating = true)}
				>
					{t('az.keys.new.open')}
				</Button>
			{/if}
		{/snippet}
		{#if capabilityOff}
			<div class="keys__panel">
				<Callout tone="info">{t('az.keys.new.capabilityOff')}</Callout>
			</div>
		{/if}
		{#if created}
			<div class="keys__panel keys__secret">
				{#if created.secret !== null}
					<Callout tone="warning" title={t('az.keys.secret.title', { name: created.name })}>
						{t('az.keys.secret.warning')}
					</Callout>
					<!-- A new secret starts hidden; once it is copied the page keeps nothing. -->
					{#each [created.id] as startedFor (startedFor)}
						<SecretField
							label={t('az.keys.secret.label')}
							value={created.secret}
							mode="show"
							once
							oncopied={() => {
								if (created?.id === startedFor) created.secret = null;
							}}
						/>
					{/each}
				{:else}
					<Callout tone="info" live>{t('az.keys.secret.copied')}</Callout>
				{/if}
				<div>
					<Button size="sm" onclick={() => (created = null)}>{t('az.keys.secret.done')}</Button>
				</div>
			</div>
		{/if}
		{#if phase === 'forbidden'}
			<div class="keys__panel"><Callout tone="info">{t('az.keys.listDenied')}</Callout></div>
		{:else if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'failed'}
			<EmptyState icon="warningCircle" title={t('az.keys.loadFailed')}>
				{#snippet action()}
					<Button size="sm" onclick={load}>{t('common.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<DataTable caption={t('az.keys.title')} {columns} rows={keys} rowKey={(row) => row.id}>
				{#snippet cell(row, column)}
					{#if column.key === 'key'}
						<CellText title={row.name} description={`${row.key_prefix}… · ${row.client_id}`} />
					{:else if column.key === 'operations'}
						{row.allowed_operations.join(', ')}
					{:else if column.key === 'state'}
						{#if expired(row)}
							<Badge tone="warning" dot>{t('az.keys.expired')}</Badge>
						{:else if row.is_active}
							<Badge tone="success" dot>{t('az.keys.active')}</Badge>
						{:else}
							<Badge dot>{t('az.keys.revoked')}</Badge>
						{/if}
					{:else if column.key === 'created'}
						{#if row.created_at}<DateTime value={row.created_at} stacked />{/if}
					{:else if row.is_active}
						<ActionMenu
							size="sm"
							label={t('az.keys.col.actions', { name: row.name })}
							actions={[
								{
									label: t('az.keys.revoke'),
									icon: 'trash',
									danger: true,
									disabled: busy,
									onselect: () => (revoking = row)
								}
							]}
						/>
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState icon="key" title={t('az.keys.empty')} />
				{/snippet}
			</DataTable>
			{#if total > pageSize}
				<Pagination {total} {pageSize} {page} onchange={(next) => (page = next)} />
			{/if}
		{/if}
	</Card>
{/if}

<CheckApiKeyCreateDialog
	open={creating}
	{tenantId}
	onsubmit={create}
	oncancel={() => (creating = false)}
/>

<ConfirmDialog
	open={revoking !== null}
	title={t('az.keys.revoke.title', { name: revoking?.name ?? '' })}
	body={t('az.keys.revoke.body')}
	confirmLabel={t('az.keys.revoke')}
	tone="danger"
	{busy}
	onconfirm={revoke}
	oncancel={() => (revoking = null)}
/>

<style>
	.keys__panel {
		display: grid;
		gap: 12px;
		padding: 16px 20px;
		border-bottom: 1px solid var(--border);
	}
</style>
