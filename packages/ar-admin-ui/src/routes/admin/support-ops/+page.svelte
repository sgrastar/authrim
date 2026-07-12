<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		adminSupportOpsAPI,
		type SupportOpsAggregateResponse,
		type SupportOpsCohortCreateResponse,
		type SupportOpsCohortPreviewResponse,
		type SupportOpsFieldDescriptor,
		type SupportOpsResourceDescriptor,
		type SupportOpsSelector,
		type SupportOpsSelectorOperator
	} from '$lib/api/admin-support-ops';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminTabs, { type AdminTabItem } from '$lib/components/admin/AdminTabs.svelte';
	import AdminToolbar from '$lib/components/admin/AdminToolbar.svelte';

	type TabId = 'aggregate' | 'cohort' | 'action';
	type SelectorRow = {
		id: string;
		field: string;
		op: SupportOpsSelectorOperator;
		value: string;
	};

	const tabs: Array<{ id: TabId; getLabel: () => string; icon: string }> = [
		{
			id: 'aggregate',
			getLabel: () => $LL.admin_support_ops_tab_aggregate(),
			icon: 'i-ph-chart-bar'
		},
		{ id: 'cohort', getLabel: () => $LL.admin_support_ops_tab_cohort(), icon: 'i-ph-funnel' },
		{ id: 'action', getLabel: () => $LL.admin_support_ops_tab_action(), icon: 'i-ph-checks' }
	];
	const supportOpsTabs = $derived<AdminTabItem[]>(
		tabs.map((tab) => ({
			id: tab.id,
			label: tab.getLabel(),
			icon: tab.icon
		}))
	);

	let activeTab = $state<TabId>('aggregate');
	let loading = $state(false);
	let error = $state('');
	let success = $state('');

	let resources = $state<SupportOpsResourceDescriptor[]>([]);
	let selectedResourceName = $state('User');
	let groupBy = $state('status');
	let actionName = $state('suspend');
	let supportCaseId = $state('');
	let actionReason = $state('');
	let currentCohortId = $state('');
	let currentActionId = $state('');
	let cohortPollTimer: ReturnType<typeof setInterval> | null = null;

	let selectorRows = $state<SelectorRow[]>([
		{ id: crypto.randomUUID(), field: 'status', op: 'eq', value: 'active' }
	]);

	let aggregateResult = $state<SupportOpsAggregateResponse | null>(null);
	let previewResult = $state<SupportOpsCohortPreviewResponse | null>(null);
	let cohortResult = $state<SupportOpsCohortCreateResponse | null>(null);
	let actionResult = $state<unknown>(null);
	let approvalUrl = $derived(
		actionResult &&
			typeof actionResult === 'object' &&
			'approval_url' in actionResult &&
			typeof actionResult.approval_url === 'string'
			? actionResult.approval_url
			: null
	);

	const selectedResource = $derived(
		resources.find((resource) => resource.resource === selectedResourceName) ?? resources[0] ?? null
	);
	const filterableFields = $derived(
		selectedResource
			? Object.entries(selectedResource.fields).filter(
					([, field]) => field.filterable && !field.sensitive
				)
			: []
	);
	const aggregatableFields = $derived(
		selectedResource
			? Object.entries(selectedResource.fields).filter(
					([, field]) => field.aggregatable && !field.sensitive
				)
			: []
	);
	const minCount = $derived(selectedResource?.minCount ?? 10);
	const currentCohortSnapshotStatus = $derived(
		cohortResult?.cohort_id === currentCohortId ? cohortResult.snapshot_status : null
	);
	const currentCohortSnapshotReady = $derived(
		!currentCohortSnapshotStatus || currentCohortSnapshotStatus === 'completed'
	);

	onMount(async () => {
		await settingsContext.initialize();
		await loadRegistry();
	});

	onDestroy(() => {
		stopCohortPolling();
	});

	async function loadRegistry() {
		loading = true;
		error = '';
		try {
			const registry = await adminSupportOpsAPI.getRegistry();
			resources = registry.resources;
			if (resources.length > 0) {
				selectedResourceName = resources[0].resource;
				const firstField = firstFilterableField();
				if (firstField) {
					selectorRows = [{ id: crypto.randomUUID(), field: firstField, op: 'eq', value: '' }];
				}
				groupBy = firstAggregatableField() ?? '';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_support_ops_load_failed();
		} finally {
			loading = false;
		}
	}

	function firstFilterableField(): string | null {
		return filterableFields[0]?.[0] ?? null;
	}

	function firstAggregatableField(): string | null {
		return aggregatableFields[0]?.[0] ?? null;
	}

	function fieldDescriptor(fieldName: string): SupportOpsFieldDescriptor | null {
		return selectedResource?.fields[fieldName] ?? null;
	}

	function resetMessages() {
		error = '';
		success = '';
	}

	function stopCohortPolling() {
		if (cohortPollTimer) {
			clearInterval(cohortPollTimer);
			cohortPollTimer = null;
		}
	}

	function startCohortPolling() {
		stopCohortPolling();
		if (!currentCohortId) return;
		cohortPollTimer = setInterval(() => {
			void refreshCohortStatus(false);
		}, 5000);
	}

	function formatCount(value: number | null | undefined): string {
		if (value === null || value === undefined) {
			return `< ${minCount}`;
		}
		return value.toLocaleString();
	}

	function formatDateTime(value: number | undefined): string {
		if (!value) return '-';
		return new Date(value).toLocaleString();
	}

	function updateRowField(rowId: string, field: string) {
		const descriptor = fieldDescriptor(field);
		selectorRows = selectorRows.map((row) =>
			row.id === rowId
				? {
						...row,
						field,
						op: descriptor?.operators[0] ?? 'eq',
						value: ''
					}
				: row
		);
	}

	function updateRow(rowId: string, patch: Partial<SelectorRow>) {
		selectorRows = selectorRows.map((row) => (row.id === rowId ? { ...row, ...patch } : row));
	}

	function addSelectorRow() {
		const field = firstFilterableField();
		if (!field) return;
		selectorRows = [...selectorRows, { id: crypto.randomUUID(), field, op: 'eq', value: '' }];
	}

	function removeSelectorRow(rowId: string) {
		if (selectorRows.length <= 1) return;
		selectorRows = selectorRows.filter((row) => row.id !== rowId);
	}

	function parseValue(
		field: SupportOpsFieldDescriptor,
		op: SupportOpsSelectorOperator,
		raw: string
	) {
		if (op === 'exists' || op === 'not_exists') {
			return undefined;
		}
		if (op === 'in') {
			return raw
				.split(',')
				.map((item) => parseSingleValue(field, item.trim()))
				.filter((item) => item !== '');
		}
		return parseSingleValue(field, raw);
	}

	function parseSingleValue(field: SupportOpsFieldDescriptor, raw: string) {
		if (field.type === 'boolean') {
			return raw === 'true';
		}
		if (field.type === 'number') {
			const parsed = Number(raw);
			return Number.isFinite(parsed) ? parsed : raw;
		}
		return raw;
	}

	function buildSelector(): SupportOpsSelector | undefined {
		const conditions = selectorRows
			.map((row) => {
				const field = fieldDescriptor(row.field);
				if (!field) return null;
				const value = parseValue(field, row.op, row.value);
				return value === undefined
					? { field: row.field, op: row.op }
					: { field: row.field, op: row.op, value };
			})
			.filter((condition): condition is NonNullable<typeof condition> => condition !== null);

		if (conditions.length === 0) return undefined;
		if (conditions.length === 1) return conditions[0];
		return { all: conditions };
	}

	async function runAggregate() {
		if (!selectedResource || !groupBy) return;
		resetMessages();
		loading = true;
		try {
			aggregateResult = await adminSupportOpsAPI.aggregate({
				resource: selectedResource.resource,
				selector: buildSelector(),
				group_by: [groupBy]
			});
			success = $LL.admin_support_ops_aggregate_completed();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_support_ops_aggregate_failed();
		} finally {
			loading = false;
		}
	}

	async function previewCohort() {
		if (!selectedResource) return;
		resetMessages();
		loading = true;
		try {
			previewResult = await adminSupportOpsAPI.previewCohort({
				resource: selectedResource.resource,
				selector: buildSelector(),
				intent: {
					action: actionName,
					reason: actionReason,
					support_case_id: supportCaseId || undefined
				}
			});
			success = $LL.admin_support_ops_preview_completed();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_support_ops_preview_failed();
		} finally {
			loading = false;
		}
	}

	async function createCohort() {
		if (!selectedResource) return;
		resetMessages();
		loading = true;
		try {
			cohortResult = await adminSupportOpsAPI.createCohort({
				resource: selectedResource.resource,
				selector: buildSelector(),
				intent: {
					action: actionName,
					reason: actionReason,
					support_case_id: supportCaseId || undefined
				}
			});
			currentCohortId = cohortResult.cohort_id;
			activeTab = 'action';
			if (
				cohortResult.snapshot_status === 'pending' ||
				cohortResult.snapshot_status === 'running'
			) {
				startCohortPolling();
				success = $LL.admin_support_ops_cohort_snapshot_queued();
			} else {
				stopCohortPolling();
				success = $LL.admin_support_ops_cohort_created();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_support_ops_cohort_creation_failed();
		} finally {
			loading = false;
		}
	}

	async function refreshCohortStatus(showMessages = true) {
		if (!currentCohortId) return;
		if (showMessages) {
			resetMessages();
			loading = true;
		}
		try {
			const latest = await adminSupportOpsAPI.getCohort(currentCohortId);
			cohortResult = latest;
			if (latest.snapshot_status === 'completed') {
				stopCohortPolling();
				if (showMessages) success = $LL.admin_support_ops_cohort_snapshot_completed();
			} else if (latest.snapshot_status === 'failed' || latest.snapshot_status === 'cancelled') {
				stopCohortPolling();
				error =
					latest.snapshot_error ||
					$LL.admin_support_ops_cohort_snapshot_status({ status: latest.snapshot_status });
			} else if (showMessages) {
				success = $LL.admin_support_ops_cohort_snapshot_running();
			}
		} catch (err) {
			if (!showMessages) stopCohortPolling();
			error = err instanceof Error ? err.message : $LL.admin_support_ops_refresh_failed();
		} finally {
			if (showMessages) loading = false;
		}
	}

	async function requestAction() {
		if (!currentCohortId || !actionReason.trim() || !currentCohortSnapshotReady) return;
		resetMessages();
		loading = true;
		try {
			const result = await adminSupportOpsAPI.requestAction({
				cohort_id: currentCohortId,
				action: actionName,
				reason: actionReason.trim(),
				support_case_id: supportCaseId || undefined
			});
			currentActionId = result.action_id;
			actionResult = result;
			success = $LL.admin_support_ops_action_requested();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_support_ops_action_request_failed();
		} finally {
			loading = false;
		}
	}

	async function approveAction() {
		if (!currentActionId) return;
		resetMessages();
		loading = true;
		try {
			actionResult = await adminSupportOpsAPI.approveAction(currentActionId);
			success = $LL.admin_support_ops_action_approved();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_support_ops_action_approval_failed();
		} finally {
			loading = false;
		}
	}

	async function executeAction() {
		if (!currentActionId) return;
		resetMessages();
		loading = true;
		try {
			actionResult = await adminSupportOpsAPI.executeAction(currentActionId);
			success = $LL.admin_support_ops_action_completed();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_support_ops_action_execution_failed();
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_support_ops_page_title()}</title>
</svelte:head>

{#snippet tenantChip()}
	<div class="tenant-chip">
		<i class="i-ph-buildings" aria-hidden="true"></i>
		<span>{settingsContext.tenantId}</span>
	</div>
{/snippet}

{#snippet selectorActions()}
	<button
		type="button"
		class="btn btn-secondary btn-sm icon-button"
		onclick={addSelectorRow}
		aria-label={$LL.admin_support_ops_add_condition()}
	>
		<i class="i-ph-plus" aria-hidden="true"></i>
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		eyebrow={$LL.admin_support_ops_eyebrow()}
		title={$LL.admin_support_ops_title()}
		titleAccessory={tenantChip}
	/>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}
	{#if success}
		<div class="alert alert-success">{success}</div>
	{/if}

	<AdminTabs
		items={supportOpsTabs}
		active={activeTab}
		onChange={(tabId) => (activeTab = tabId as TabId)}
		ariaLabel={$LL.admin_support_ops_title()}
	/>

	<AdminSection title={$LL.admin_support_ops_selector()} actions={selectorActions}>
		<AdminToolbar>
			<div class="admin-field support-field">
				<label for="support-resource" class="admin-field__label">
					{$LL.admin_support_ops_resource()}
				</label>
				<select id="support-resource" class="admin-select" bind:value={selectedResourceName}>
					{#each resources as resource (resource.resource)}
						<option value={resource.resource}>{resource.displayName}</option>
					{/each}
				</select>
			</div>
			<div class="admin-field support-field">
				<label for="support-case-id" class="admin-field__label">
					{$LL.admin_support_ops_support_case()}
				</label>
				<input
					id="support-case-id"
					class="admin-input"
					bind:value={supportCaseId}
					placeholder="CASE-1234"
				/>
			</div>
			<div class="admin-field support-field">
				<label for="support-action" class="admin-field__label">
					{$LL.admin_support_ops_tab_action()}
				</label>
				<select id="support-action" class="admin-select" bind:value={actionName}>
					<option value="suspend">{$LL.admin_support_ops_action_suspend()}</option>
				</select>
			</div>
		</AdminToolbar>

		<div class="selector-list">
			{#each selectorRows as row (row.id)}
				<div class="selector-row">
					<select
						class="admin-select"
						value={row.field}
						onchange={(event) => updateRowField(row.id, event.currentTarget.value)}
					>
						{#each filterableFields as [fieldName] (fieldName)}
							<option value={fieldName}>{fieldName}</option>
						{/each}
					</select>
					<select
						class="admin-select"
						value={row.op}
						onchange={(event) =>
							updateRow(row.id, { op: event.currentTarget.value as SupportOpsSelectorOperator })}
					>
						{#each fieldDescriptor(row.field)?.operators ?? [] as op (op)}
							<option value={op}>{op}</option>
						{/each}
					</select>
					{#if row.op === 'exists' || row.op === 'not_exists'}
						<input
							class="admin-input"
							value=""
							disabled
							aria-label={$LL.admin_support_ops_no_value()}
						/>
					{:else if fieldDescriptor(row.field)?.values}
						<select
							class="admin-select"
							value={row.value}
							onchange={(event) => updateRow(row.id, { value: event.currentTarget.value })}
						>
							<option value=""></option>
							{#each fieldDescriptor(row.field)?.values ?? [] as value (String(value))}
								<option value={String(value)}>{String(value)}</option>
							{/each}
						</select>
					{:else if fieldDescriptor(row.field)?.type === 'boolean'}
						<select
							class="admin-select"
							value={row.value}
							onchange={(event) => updateRow(row.id, { value: event.currentTarget.value })}
						>
							<option value="true">true</option>
							<option value="false">false</option>
						</select>
					{:else}
						<input
							class="admin-input"
							value={row.value}
							oninput={(event) => updateRow(row.id, { value: event.currentTarget.value })}
						/>
					{/if}
					<button
						type="button"
						class="btn btn-secondary btn-sm icon-button danger"
						disabled={selectorRows.length <= 1}
						onclick={() => removeSelectorRow(row.id)}
						aria-label={$LL.admin_support_ops_remove_condition()}
					>
						<i class="i-ph-trash" aria-hidden="true"></i>
					</button>
				</div>
			{/each}
		</div>
	</AdminSection>

	{#if activeTab === 'aggregate'}
		<AdminSection title={$LL.admin_support_ops_tab_aggregate()}>
			<AdminToolbar>
				<div class="admin-field support-field support-field--compact">
					<label for="support-group-by" class="admin-field__label">
						{$LL.admin_support_ops_group_by()}
					</label>
					<select id="support-group-by" class="admin-select" bind:value={groupBy}>
						{#each aggregatableFields as [fieldName] (fieldName)}
							<option value={fieldName}>{fieldName}</option>
						{/each}
					</select>
				</div>
				<button
					type="button"
					class="btn btn-primary"
					disabled={loading || !groupBy}
					onclick={runAggregate}
				>
					<i class="i-ph-chart-bar" aria-hidden="true"></i>
					<span>{$LL.admin_support_ops_run()}</span>
				</button>
			</AdminToolbar>

			{#if aggregateResult}
				<AdminDataTable>
					<thead>
						<tr>
							<th>{$LL.admin_support_ops_group()}</th>
							<th>{$LL.admin_support_ops_count()}</th>
						</tr>
					</thead>
					<tbody>
						{#each aggregateResult.groups as group (JSON.stringify(group.key))}
							<tr>
								<td>{Object.values(group.key).join(' / ')}</td>
								<td>{group.count.toLocaleString()}</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
				<div class="privacy-line">
					min_count {aggregateResult.privacy.min_count} · bucket
					{aggregateResult.privacy.count_precision} · suppressed {aggregateResult.suppressed_groups}
				</div>
			{/if}
		</AdminSection>
	{:else if activeTab === 'cohort'}
		<AdminSection title={$LL.admin_support_ops_tab_cohort()}>
			<div class="admin-field support-field support-field--full">
				<label for="support-cohort-reason" class="admin-field__label">
					{$LL.admin_support_ops_reason()}
				</label>
				<textarea
					id="support-cohort-reason"
					class="admin-input support-textarea"
					bind:value={actionReason}
					rows="3"
				></textarea>
			</div>
			<div class="actions">
				<button type="button" class="btn btn-secondary" disabled={loading} onclick={previewCohort}>
					<i class="i-ph-eye" aria-hidden="true"></i>
					<span>{$LL.admin_support_ops_preview()}</span>
				</button>
				<button type="button" class="btn btn-primary" disabled={loading} onclick={createCohort}>
					<i class="i-ph-funnel" aria-hidden="true"></i>
					<span>{$LL.admin_support_ops_create_cohort()}</span>
				</button>
			</div>

			{#if previewResult}
				<div class="summary-grid">
					<div>
						<span>{$LL.admin_support_ops_matched()}</span><strong
							>{formatCount(previewResult.matched_count)}</strong
						>
					</div>
					<div>
						<span>{$LL.admin_support_ops_actionable()}</span><strong
							>{formatCount(previewResult.actionable_count)}</strong
						>
					</div>
					<div>
						<span>{$LL.admin_support_ops_blocked()}</span><strong
							>{formatCount(previewResult.blocked_count)}</strong
						>
					</div>
					<div>
						<span>{$LL.admin_support_ops_risk()}</span><strong
							>{previewResult.risk.risk_level}</strong
						>
					</div>
				</div>
				<div class="privacy-line">
					min_count {previewResult.risk.min_count} · selector {previewResult.selector_hash}
				</div>
			{/if}

			{#if cohortResult}
				<div class="result-strip">
					<span>{cohortResult.cohort_id}</span>
					<span>{cohortResult.snapshot_status}</span>
					{#if cohortResult.snapshot_job_id}
						<span>job {cohortResult.snapshot_job_id}</span>
					{/if}
					<span>expires {formatDateTime(cohortResult.expires_at)}</span>
					<button
						type="button"
						class="btn btn-secondary btn-sm mini-button"
						disabled={loading}
						onclick={() => refreshCohortStatus()}
					>
						<i class="i-ph-arrows-clockwise" aria-hidden="true"></i>
						<span>{$LL.admin_support_ops_refresh()}</span>
					</button>
				</div>
			{/if}
		</AdminSection>
	{:else}
		<AdminSection title={$LL.admin_support_ops_tab_action()}>
			<AdminToolbar>
				<div class="admin-field support-field">
					<label for="support-cohort-id" class="admin-field__label">
						{$LL.admin_support_ops_cohort_id()}
					</label>
					<input id="support-cohort-id" class="admin-input" bind:value={currentCohortId} />
				</div>
				<div class="admin-field support-field">
					<label for="support-action-id" class="admin-field__label">
						{$LL.admin_support_ops_action_id()}
					</label>
					<input id="support-action-id" class="admin-input" bind:value={currentActionId} />
				</div>
			</AdminToolbar>
			<div class="admin-field support-field support-field--full">
				<label for="support-action-reason" class="admin-field__label">
					{$LL.admin_support_ops_reason()}
				</label>
				<textarea
					id="support-action-reason"
					class="admin-input support-textarea"
					bind:value={actionReason}
					rows="3"
				></textarea>
			</div>
			<div class="actions">
				<button
					type="button"
					class="btn btn-secondary"
					disabled={loading || !currentCohortId || !currentCohortSnapshotReady}
					onclick={requestAction}
				>
					<i class="i-ph-paper-plane-tilt" aria-hidden="true"></i>
					<span>{$LL.admin_support_ops_request()}</span>
				</button>
				{#if approvalUrl}
					<a class="btn btn-secondary link-button" href={approvalUrl}>
						<i class="i-ph-check" aria-hidden="true"></i>
						<span>{$LL.admin_support_ops_approval()}</span>
					</a>
				{:else}
					<button
						type="button"
						class="btn btn-secondary"
						disabled={loading || !currentActionId}
						onclick={approveAction}
					>
						<i class="i-ph-check" aria-hidden="true"></i>
						<span>{$LL.admin_support_ops_approve()}</span>
					</button>
				{/if}
				<button
					type="button"
					class="btn btn-primary"
					disabled={loading || !currentActionId}
					onclick={executeAction}
				>
					<i class="i-ph-play" aria-hidden="true"></i>
					<span>{$LL.admin_support_ops_execute()}</span>
				</button>
			</div>
			{#if currentCohortSnapshotStatus && currentCohortSnapshotStatus !== 'completed'}
				<div class="privacy-line">
					{$LL.admin_support_ops_snapshot_not_ready({
						status: currentCohortSnapshotStatus
					})}
				</div>
			{/if}
			{#if actionResult}
				<pre>{JSON.stringify(actionResult, null, 2)}</pre>
			{/if}
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.tenant-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		color: var(--color-text-muted);
		background: var(--color-surface-raised);
		font-family: var(--font-meta, var(--font-body));
		font-size: 0.82rem;
		font-weight: 650;
	}

	.support-field {
		flex: 1 1 220px;
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.support-field--compact {
		flex: 0 1 320px;
	}

	.support-field--full {
		margin-bottom: 14px;
	}

	.support-field :global(.admin-field__label) {
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
		color: var(--color-text-subtle);
	}

	.support-field :global(.admin-input),
	.support-field :global(.admin-select),
	.selector-row :global(.admin-input),
	.selector-row :global(.admin-select) {
		width: 100%;
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.support-field :global(.admin-input:focus),
	.support-field :global(.admin-select:focus),
	.selector-row :global(.admin-input:focus),
	.selector-row :global(.admin-select:focus) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.support-textarea {
		resize: vertical;
	}

	.selector-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.selector-row {
		display: grid;
		grid-template-columns: 1.2fr 0.8fr 1.4fr 40px;
		gap: 10px;
		align-items: center;
	}

	.icon-button {
		width: 38px;
		min-width: 38px;
		padding: 0;
	}

	.icon-button.danger {
		color: var(--color-danger);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 12px;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
	}

	.summary-grid > div {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 12px;
		background: var(--color-surface-raised);
	}

	.summary-grid span,
	.privacy-line {
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.summary-grid strong {
		display: block;
		margin-top: 4px;
		color: var(--color-text);
		font-size: 1.35rem;
	}

	.result-strip {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		border-top: 1px solid var(--color-border);
		padding-top: 12px;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 0.84rem;
	}

	.mini-button {
		min-height: 28px;
		padding: 0 10px;
		font-family: inherit;
		font-size: 0.78rem;
	}

	pre {
		max-height: 360px;
		overflow: auto;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 12px;
		background: var(--color-surface-raised);
		color: var(--color-text);
		font-family: var(--font-mono);
	}

	@media (max-width: 860px) {
		.selector-row,
		.summary-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
