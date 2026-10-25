<script lang="ts">
	import { tick, untrack } from 'svelte';
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
	import { ApiError } from '$lib/api/api-error';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { formatNumber } from '$lib/ui/format';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import RadioGroup from '$lib/ui/primitives/RadioGroup.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import MappingSection from './MappingSection.svelte';
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
		active?: boolean;
		refresh?: number;
		/** Opens the claim-change preview (MAP-05) for the chosen set. */
		onpreview?: (setId: string) => void;
		ontenant?: (tenantId: string, name: string) => void;
		onbusy?: (busy: boolean) => void;
	}

	let { client, onpreview, ontenant, onbusy, active = true, refresh = 0 }: Props = $props();

	let overview = $state<PlatformTenantsOverview | null>(null);
	let sets = $state<MappingSetSummary[]>([]);
	let loadError = $state(false);

	let setId = $state('');
	let policy = $state<'skip' | 'overwrite'>('skip');
	let selected = $state<string[]>([]);
	let editing = $state(false);
	let editor = $state<HTMLDivElement>();
	async function openEditor() {
		editing = true;
		await tick();
		editor?.querySelector('select')?.focus();
	}
	let search = $state('');

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
	$effect(() => {
		onbusy?.(running || retrying);
	});
	let result = $state<BulkApplyResponse<BulkApplyResult> | null>(null);
	let actionError = $state('');

	/**
	 * Every page of the tenant list: an operator picks across all tenants, and "select all" must
	 * mean all of them. Pages of up to 100 (the API's most).
	 */
	async function readAllTenants(): Promise<PlatformTenantsOverview> {
		let page = await client.tenantsOverview({ limit: 100 });
		const rows = [...page.tenants];
		while (page.next_cursor) {
			page = await client.tenantsOverview({ cursor: page.next_cursor, limit: 100 });
			rows.push(...page.tenants);
		}
		return { ...page, tenants: rows, next_cursor: null };
	}

	let generation = 0;
	async function load(reconcile = false) {
		const mine = ++generation;
		loadError = false;
		try {
			const [next, list] = await Promise.all([readAllTenants(), client.sets('platform')]);
			if (mine !== generation) return;
			if (reconcile && overview && JSON.stringify(overview) !== JSON.stringify(next)) {
				preview = null;
				previewed = null;
			}
			overview = next;
			sets = list.sets.filter((set) => set.owner === 'platform' && set.enabled);
		} catch {
			if (mine === generation) loadError = true;
		}
	}

	let lastRefresh = 0;
	let checkGeneration = 0;
	$effect(() => {
		const revision = refresh;
		void client;
		++checkGeneration;
		checking = false;
		if (!active) return;
		untrack(() => {
			if (revision !== lastRefresh) {
				preview = null;
				previewed = null;
			}
			lastRefresh = revision;
			void load(true);
		});
		return () => {
			++generation;
		};
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
	/** Tenants of a run whose batch never got an answer (the request itself failed). */
	let unsent = $state<string[]>([]);
	const notApplied = $derived(result?.results.filter((r) => !succeeded(r.status)) ?? []);
	/**
	 * Run again: the tenants that failed or conflicted, and the ones never sent, each once (a
	 * tenant can be both after a retry is itself lost).
	 */
	const retryIds = $derived([
		...new Set([
			...notApplied
				.filter((r) => r.status === 'failed' || r.status === 'conflict')
				.map((r) => r.tenant_id),
			...unsent
		])
	]);
	/** Tenants not changed as asked, each counted once. */
	const failedCount = $derived(new Set([...notApplied.map((r) => r.tenant_id), ...unsent]).size);

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

	/**
	 * The most tenants one bulk request may name: the API's default until an answer says (its
	 * `limits`), or a refusal names the limit. A selection larger than that goes in batches.
	 */
	let batchSize = 25;

	async function inBatches<R extends { status: string }>(
		tenantIds: string[],
		send: (batch: string[]) => Promise<BulkApplyResponse<R>>
	): Promise<BulkApplyResponse<R>> {
		const results: R[] = [];
		let last: BulkApplyResponse<R> | null = null;
		let start = 0;
		while (start < tenantIds.length) {
			const batch = tenantIds.slice(start, start + batchSize);
			try {
				last = await send(batch);
			} catch (error) {
				const limit = error instanceof ApiError ? error.body.limit : undefined;
				if (
					error instanceof ApiError &&
					error.body.code === 'too_many_tenants' &&
					typeof limit === 'number' &&
					limit > 0 &&
					limit < batch.length
				) {
					batchSize = limit;
					continue;
				}
				throw error;
			}
			batchSize = last.limits.max_tenants_per_request;
			results.push(...last.results);
			start += batch.length;
		}
		const byStatus: Record<string, number> = {};
		for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
		return { ...last!, results, summary: { tenants: results.length, by_status: byStatus } };
	}

	async function check() {
		// One thing at a time: a check while a run is going would mix their results.
		if (running || retrying) return;
		const mine = ++checkGeneration;
		const operation: Operation = { setId, policy, signature };
		const tenantIds = [...selected];
		checking = true;
		actionError = '';
		try {
			const answer = await inBatches(tenantIds, (batch) =>
				client.bulkPreview(request('preview', batch, operation))
			);
			// An answer for a choice changed meanwhile is not shown as the current one.
			if (mine !== checkGeneration || !active || operation.signature !== signature) return;
			preview = answer;
			previewed = operation;
			result = null;
			unsent = [];
		} catch {
			if (mine === checkGeneration) actionError = t('mc.actionFailed');
		} finally {
			if (mine === checkGeneration) checking = false;
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
		ran = operation;
		// Until its batch is answered, each tenant counts as not sent: a failing request leaves the
		// rest listed, to run again, and the tenants already answered keep their outcome.
		unsent = [...new Set([...unsent, ...tenantIds])];
		try {
			// Batch by batch, each kept as it comes: a later batch failing loses none of them.
			await inBatches(tenantIds, async (batch) => {
				const answer = await client.bulkApply(
					{
						...request('apply', batch, operation),
						expected: Object.fromEntries(batch.map((id) => [id, expected[id]]))
					},
					crypto.randomUUID()
				);
				// Results of earlier runs stay; the tenants run again take their new result.
				const again = new Set(answer.results.map((r) => r.tenant_id));
				const earlier = result?.results.filter((r) => !again.has(r.tenant_id)) ?? [];
				result = { ...answer, results: [...earlier, ...answer.results] };
				unsent = unsent.filter((id) => !again.has(id));
				return answer;
			});
		} finally {
			overview = await readAllTenants();
		}
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
		} catch {
			// Some batches may have been applied: the result lists them, and the rest as not sent.
			// The dialog closes so its versions are never sent again; retry checks anew.
			actionError = t('mc.actionFailed');
		} finally {
			confirming = false;
			running = false;
		}
	}

	/** Runs the confirmed operation again for the tenants it could not change, not the form now. */
	async function retry() {
		if (!ran || checking) return;
		const operation = ran;
		retrying = true;
		actionError = '';
		const ids = [...retryIds];
		try {
			// A tenant changed since the first check needs its new version: check those again.
			const plan = await inBatches(ids, (batch) =>
				client.bulkPreview(request('preview', batch, operation))
			);
			await run(plan, ids, operation);
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

<MappingSection>
	{#if loadError}
		<Callout tone="warning" live>
			{t('mc.loadFailed')}
			<Button variant="secondary" size="sm" onclick={() => load(true)}>{t('mc.retry')}</Button>
		</Callout>
	{:else if !overview}
		<LoadingState label={t('mc.loading')} />
	{:else}
		<TextField label={t('mc.nav.searchTenants')} bind:value={search} />

		{#if editing && selected.length > 0}
			<Card title={t('mc.ro.setCard')}>
				<div class="form" bind:this={editor}>
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

			<Button disabled={!setId || running || retrying} loading={checking} onclick={check}
				>{t('mc.ro.check')}</Button
			>
		{/if}

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

		{#if result || unsent.length > 0}
			<Card title={t('mc.ro.result')}>
				<div class="form">
					<p class="lead">
						{t('mc.ro.result.summary', {
							applied: result?.results.filter((r) => r.status === 'applied').length ?? 0,
							skipped: result?.results.filter((r) => r.status === 'skipped').length ?? 0,
							failed: failedCount
						})}
					</p>
					{#if failedCount > 0}
						<Callout tone="warning" live>{t('mc.ro.result.partial')}</Callout>
						{#if retryIds.length > 0}
							<div class="actions">
								<Button loading={retrying} disabled={checking} onclick={retry}>
									{t('mc.ro.retry', { count: retryIds.length })}
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
				rows={overview.tenants.filter((row) =>
					row.display_name.toLowerCase().includes(search.toLowerCase())
				)}
				rowKey={(row) => row.tenant_id}
			>
				{#snippet bulkActions()}
					<Button size="sm" variant="secondary" disabled={running || retrying} onclick={openEditor}
						>{t('mc.nav.changeDefault')}</Button
					>
				{/snippet}
				{#snippet cell(row, column)}
					{#if column.key === 'tenant'}
						{#if ontenant}<Button
								size="sm"
								variant="ghost"
								disabled={running || retrying}
								onclick={() => ontenant?.(row.tenant_id, row.display_name)}
								>{row.display_name}</Button
							>{:else}<strong>{row.display_name}</strong>{/if}
					{:else if column.key === 'default'}
						{#if row.tenant_default}
							<span class:muted={row.tenant_default.state === 'unset'}>
								{chainValueText(row.tenant_default)}
							</span>
						{:else}
							<span class="muted">—</span>
						{/if}
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
						{#if unsent.includes(row.tenant_id)}
							<Badge tone="warning">{t('mc.ro.status.unsent')}</Badge>
						{:else if outcome}
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
	{/if}
</MappingSection>

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
