<script lang="ts">
	import {
		IDENTITY_MAPPING_CATEGORY,
		OIDC_DEFAULT_SET_KEY,
		type BulkApplyRequest,
		type BulkApplyResponse,
		type BulkApplyResult,
		type BulkPreviewResult,
		type IdentityMappingClient,
		type MappingSetSummary,
		type PlatformTenantsOverview
	} from '$lib/api/identity-mapping';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { formatNumber } from '$lib/ui/format';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import RadioGroup from '$lib/ui/primitives/RadioGroup.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import { chainValueText, label } from './labels';
	import SourceLabel from './SourceLabel.svelte';

	/**
	 * MAP-01: give one platform set to the tenants chosen, as their tenant default. The impact is
	 * the bulk apply's preview (per tenant: would change, or why not, and the apps it reaches);
	 * running it needs the number of tenants typed; tenants are changed one by one, and only the
	 * ones not changed are retried. The source column is read again after running.
	 */
	interface Props {
		client: IdentityMappingClient;
		/** Opens the claim-change preview (MAP-05) for the chosen set. */
		onpreview?: (setId: string) => void;
	}

	let { client, onpreview }: Props = $props();

	let overview = $state<PlatformTenantsOverview | null>(null);
	let sets = $state<MappingSetSummary[]>([]);
	let loadError = $state(false);

	let setId = $state('');
	let policy = $state<'skip' | 'overwrite'>('skip');
	let selected = $state<string[]>([]);

	/** What one check or run is about: fixed when it is sent, so later edits do not change it. */
	interface Operation {
		setId: string;
		policy: 'skip' | 'overwrite';
		signature: string;
	}

	let preview = $state<BulkApplyResponse<BulkPreviewResult> | null>(null);
	/** The operation the preview shown was made for, and the one last run (for a retry). */
	let previewed = $state<Operation | null>(null);
	let ran = $state<Operation | null>(null);
	let checking = $state(false);

	let confirming = $state(false);
	let typed = $state('');
	let confirmError = $state('');
	let running = $state(false);
	let retrying = $state(false);
	let result = $state<BulkApplyResponse<BulkApplyResult> | null>(null);
	let actionError = $state('');

	async function load() {
		loadError = false;
		try {
			const [next, list] = await Promise.all([client.tenantsOverview(), client.sets('platform')]);
			overview = next;
			sets = list.sets.filter((set) => set.owner === 'platform' && set.enabled);
		} catch {
			loadError = true;
		}
	}

	$effect(() => {
		void load();
	});

	const signature = $derived(`${setId}|${policy}|${[...selected].sort().join(',')}`);
	const stale = $derived(preview !== null && previewed?.signature !== signature);
	const ready = $derived(preview?.results.filter((r) => r.status === 'ready') ?? []);
	const unchanged = $derived(preview?.results.filter((r) => r.status !== 'ready') ?? []);
	const impact = (r: BulkPreviewResult) => {
		const value = r.impact[IDENTITY_MAPPING_CATEGORY];
		return value && value.available ? value : null;
	};
	/** Tenants that would change but whose apps could not be counted: never shown as zero. */
	const uncounted = $derived(ready.filter((r) => impact(r) === null));
	const sum = (pick: (r: BulkPreviewResult) => number | undefined) =>
		ready.reduce((total, r) => total + (pick(r) ?? 0), 0);
	const planOf = $derived(new Map(preview?.results.map((r) => [r.tenant_id, r]) ?? []));
	const resultOf = $derived(new Map(result?.results.map((r) => [r.tenant_id, r]) ?? []));
	const succeeded = (status: string) =>
		status === 'applied' || status === 'cleared' || status === 'skipped';
	/** Every tenant not changed as asked; the ones that failed or conflicted can be run again. */
	const notApplied = $derived(result?.results.filter((r) => !succeeded(r.status)) ?? []);
	const retryable = $derived(
		notApplied.filter((r) => r.status === 'failed' || r.status === 'conflict')
	);

	const request = (
		mode: 'preview' | 'apply',
		tenantIds: string[],
		operation: Operation
	): BulkApplyRequest => ({
		mode,
		tenant_ids: tenantIds,
		changes: [
			{ category: IDENTITY_MAPPING_CATEGORY, set: { [OIDC_DEFAULT_SET_KEY]: operation.setId } }
		],
		on_existing_override: operation.policy
	});

	async function check() {
		// One thing at a time: a check while a run is going would mix their results.
		if (running || retrying) return;
		const operation: Operation = { setId, policy, signature };
		const tenantIds = [...selected];
		checking = true;
		actionError = '';
		try {
			const answer = await client.bulkPreview(request('preview', tenantIds, operation));
			// An answer for a choice changed meanwhile is not shown as the current one.
			if (operation.signature !== signature) return;
			preview = answer;
			previewed = operation;
			result = null;
		} catch {
			actionError = t('mc.actionFailed');
		} finally {
			checking = false;
		}
	}

	async function run(
		plan: BulkApplyResponse<BulkPreviewResult>,
		tenantIds: string[],
		operation: Operation
	) {
		const expected = Object.fromEntries(
			plan.results.map((r) => [
				r.tenant_id,
				{ [IDENTITY_MAPPING_CATEGORY]: r.changes[0]?.version ?? '' }
			])
		);
		const answer = await client.bulkApply(
			{ ...request('apply', tenantIds, operation), expected },
			crypto.randomUUID()
		);
		ran = operation;
		// Results of earlier runs stay; the tenants run again take their new result.
		const again = new Set(answer.results.map((r) => r.tenant_id));
		const earlier = result?.results.filter((r) => !again.has(r.tenant_id)) ?? [];
		result = { ...answer, results: [...earlier, ...answer.results] };
		overview = await client.tenantsOverview();
	}

	async function apply() {
		if (!preview || !previewed || stale) return;
		if (typed.trim() !== String(ready.length)) {
			confirmError = t('mc.ro.confirm.mismatch');
			return;
		}
		running = true;
		try {
			await run(
				preview,
				ready.map((r) => r.tenant_id),
				previewed
			);
			confirming = false;
		} catch {
			confirmError = t('mc.actionFailed');
		} finally {
			running = false;
		}
	}

	/** Runs the confirmed operation again for the tenants it could not change, not the form now. */
	async function retry() {
		if (!ran || checking) return;
		const operation = ran;
		retrying = true;
		actionError = '';
		const ids = retryable.map((r) => r.tenant_id);
		try {
			// A tenant changed since the first check needs its new version: check those again.
			await run(await client.bulkPreview(request('preview', ids, operation)), ids, operation);
		} catch {
			actionError = t('mc.actionFailed');
		} finally {
			retrying = false;
		}
	}

	function openConfirm() {
		typed = '';
		confirmError = '';
		confirming = true;
	}

	const statusTone = (status: string) =>
		status === 'applied' ? 'success' : status === 'skipped' ? 'neutral' : 'warning';
	const setName = $derived(
		sets.find((s) => s.id === previewed?.setId)?.display_name ?? previewed?.setId ?? ''
	);
	const num = (n: number) => formatNumber(n, i18n.locale);
	const tenantName = (id: string) =>
		overview?.tenants.find((row) => row.tenant_id === id)?.display_name ?? id;
</script>

<Page width="wide">
	<PageHeader title={t('mc.ro.title')} description={t('mc.ro.desc')} />

	{#if loadError}
		<Callout tone="warning" live>
			{t('mc.loadFailed')}
			<Button variant="secondary" size="sm" onclick={load}>{t('mc.retry')}</Button>
		</Callout>
	{:else if !overview}
		<LoadingState label={t('mc.loading')} />
	{:else}
		<Card title={t('mc.ro.setCard')}>
			<div class="form">
				<p class="muted">
					{t('mc.ro.platformDefault', { value: chainValueText(overview.platform_default) })}
				</p>
				<Select
					label={t('mc.ro.setLabel')}
					hint={t('mc.ro.setHint')}
					placeholder={t('mc.ro.choose')}
					options={sets.map((s) => ({ value: s.id, label: s.display_name ?? s.id }))}
					bind:value={setId}
				/>
				<RadioGroup
					label={t('mc.ro.existing')}
					orientation="horizontal"
					options={[
						{ value: 'skip', label: t('mc.ro.existing.skip') },
						{ value: 'overwrite', label: t('mc.ro.existing.overwrite') }
					]}
					value={policy}
					onchange={(value) => (policy = value === 'overwrite' ? 'overwrite' : 'skip')}
				/>
			</div>
		</Card>

		<Card title={t('mc.ro.tenants')} flush>
			<DataTable
				caption={t('mc.ro.tenants')}
				selectable
				bind:selected
				rowLabel={(row) => row.display_name}
				columns={[
					{ key: 'tenant', label: t('mc.ro.col.tenant'), width: '14%' },
					{ key: 'default', label: t('mc.ro.col.default'), width: '18%' },
					{ key: 'source', label: t('mc.ro.col.source'), width: '24%' },
					{ key: 'apps', label: t('mc.ro.col.apps'), width: '8%', align: 'end' },
					{ key: 'plan', label: t('mc.ro.col.plan') },
					{ key: 'result', label: t('mc.ro.col.result'), width: '16%' }
				]}
				rows={overview.tenants}
				rowKey={(row) => row.tenant_id}
			>
				{#snippet bulkActions()}
					<Button
						size="sm"
						variant="secondary"
						disabled={!setId || running || retrying}
						loading={checking}
						onclick={check}
					>
						{t('mc.ro.check')}
					</Button>
				{/snippet}
				{#snippet cell(row, column)}
					{#if column.key === 'tenant'}
						<strong>{row.display_name}</strong>
					{:else if column.key === 'default'}
						<span class:muted={row.tenant_default.state === 'unset'}>
							{chainValueText(row.tenant_default)}
						</span>
					{:else if column.key === 'source'}
						<SourceLabel selection={row.effective} />
					{:else if column.key === 'apps'}
						{#if row.apps}
							{num(row.apps.total)}
						{:else}
							<span class="muted">—</span>
						{/if}
					{:else if column.key === 'plan'}
						{@const plan = stale ? undefined : planOf.get(row.tenant_id)}
						{#if plan?.status === 'ready' && impact(plan) === null}
							{t('mc.ro.plan.uncounted')}
						{:else if plan?.status === 'ready'}
							{t('mc.ro.plan.apply', { count: impact(plan)?.apps_following_default ?? 0 })}
						{:else if plan}
							<span class="muted">
								{label('mc.ro.reason.', plan.changes[0]?.reason ?? plan.reason ?? '')}
							</span>
						{/if}
					{:else}
						{@const outcome = resultOf.get(row.tenant_id)}
						{#if outcome}
							<span class="stack">
								<Badge tone={statusTone(outcome.status)}>
									{label('mc.ro.status.', outcome.status)}
								</Badge>
								{#if !succeeded(outcome.status)}
									<span class="muted">
										{label('mc.ro.reason.', outcome.changes[0]?.reason ?? outcome.reason ?? '')}
									</span>
								{/if}
							</span>
						{/if}
					{/if}
				{/snippet}
			</DataTable>
		</Card>

		{#if actionError}
			<Callout tone="warning" live>{actionError}</Callout>
		{/if}

		{#if preview && !result}
			<Card title={t('mc.ro.impact')}>
				<div class="form">
					{#if stale}
						<Callout tone="info">{t('mc.ro.impact.stale')}</Callout>
					{:else if ready.length === 0}
						<p>{t('mc.ro.impact.nothing')}</p>
					{:else}
						<p class="lead">
							{t('mc.ro.impact.summary', {
								tenants: ready.length,
								apps: sum((r) => impact(r)?.apps_following_default)
							})}
						</p>
						<p>
							{t('mc.ro.impact.unchanged', {
								own: sum((r) => impact(r)?.apps_with_own_set),
								optedOut: sum((r) => impact(r)?.apps_opted_out)
							})}
						</p>
						{#if uncounted.length > 0}
							<Callout tone="warning">
								{t('mc.ro.impact.unavailable', {
									names: uncounted.map((r) => tenantName(r.tenant_id)).join(', ')
								})}
							</Callout>
						{/if}
						{#if sum((r) => impact(r)?.apps_with_unusable_choice) > 0}
							<Callout tone="warning">
								{t('mc.ro.impact.unusable', {
									count: sum((r) => impact(r)?.apps_with_unusable_choice)
								})}
							</Callout>
						{/if}
					{/if}
					{#if !stale && unchanged.length > 0}
						<div>
							<p class="muted">{t('mc.ro.impact.skipped', { count: unchanged.length })}</p>
							<ul class="reasons">
								{#each unchanged as r (r.tenant_id)}
									<li>
										<strong>{tenantName(r.tenant_id)}</strong>
										<span class="muted">
											{label('mc.ro.reason.', r.changes[0]?.reason ?? r.reason ?? '')}
										</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if !stale && ready.length > 0}
						<div class="actions">
							<Button onclick={openConfirm}>{t('mc.ro.run', { count: ready.length })}</Button>
							{#if onpreview}
								<Button variant="secondary" onclick={() => previewed && onpreview(previewed.setId)}>
									{t('mc.ro.impact.preview')}
								</Button>
							{/if}
						</div>
					{/if}
				</div>
			</Card>
		{/if}

		{#if result}
			<Card title={t('mc.ro.result')}>
				<div class="form">
					<p class="lead">
						{t('mc.ro.result.summary', {
							applied: result.results.filter((r) => r.status === 'applied').length,
							skipped: result.results.filter((r) => r.status === 'skipped').length,
							failed: notApplied.length
						})}
					</p>
					{#if notApplied.length > 0}
						<Callout tone="warning" live>{t('mc.ro.result.partial')}</Callout>
						{#if retryable.length > 0}
							<div class="actions">
								<Button loading={retrying} disabled={checking} onclick={retry}>
									{t('mc.ro.retry', { count: retryable.length })}
								</Button>
							</div>
						{/if}
					{:else}
						<Callout tone="info" live>{t('mc.ro.result.done')}</Callout>
					{/if}
					<p class="muted">{t('mc.ro.after.desc')}</p>
				</div>
			</Card>
		{/if}
	{/if}
</Page>

<FormDialog
	open={confirming}
	title={t('mc.ro.confirm.title', { count: ready.length })}
	description={t('mc.ro.confirm.body', { set: setName })}
	submitLabel={t('mc.ro.confirm.submit')}
	busy={running}
	error={confirmError}
	onsubmit={apply}
	oncancel={() => (confirming = false)}
>
	<TextField
		label={t('mc.ro.confirm.label')}
		hint={t('mc.ro.confirm.hint', { count: ready.length })}
		inputmode="numeric"
		autocomplete="off"
		bind:value={typed}
	/>
</FormDialog>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.form p {
		margin: 0;
	}

	.lead {
		font-weight: var(--fw-semibold);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}

	.reasons {
		margin: var(--space-related) 0 0;
		padding-inline-start: 1.2em;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.reasons li {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}

	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.muted {
		color: var(--text-secondary);
	}
</style>
