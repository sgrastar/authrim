<script lang="ts">
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';
	import { getFlowKindLabel, getSavedFlowDescription } from '$lib/admin/flow-i18n';
	import {
		adminFlowsAPI,
		type AdminFlow,
		type AdminFlowStatus,
		type FlowRuntimeContractPackage,
		type FlowValidationIssue
	} from '$lib/api/admin-flows';
	import { Modal } from '$lib/components';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { onMount } from 'svelte';

	const MAX_IMPORT_JSON_BYTES = 512 * 1024;

	let flows = $state<AdminFlow[]>([]);
	let activeAssignmentCounts = $state<Record<string, number>>({});
	let flowsLoading = $state(true);
	let flowsError = $state('');
	let importModalOpen = $state(false);
	let importJson = $state('');
	let importError = $state('');
	let importing = $state(false);
	let importValidationRan = $state(false);
	let importValidationIssues = $state<FlowValidationIssue[]>([]);

	onMount(() => {
		void loadFlows();
	});

	async function loadFlows() {
		flowsLoading = true;
		flowsError = '';
		try {
			const [flowResponse, assignmentResponse] = await Promise.all([
				adminFlowsAPI.list(),
				adminFlowsAPI.listAssignments()
			]);
			flows = flowResponse.flows;
			activeAssignmentCounts = assignmentResponse.assignments.reduce<Record<string, number>>(
				(counts, assignment) => {
					if (assignment.enabled) {
						counts[assignment.flow_id] = (counts[assignment.flow_id] ?? 0) + 1;
					}
					return counts;
				},
				{}
			);
		} catch (error) {
			flowsError = error instanceof Error ? error.message : $LL.admin_flows_load_error();
		} finally {
			flowsLoading = false;
		}
	}

	function getAdminFlowStatusLabel(status: AdminFlowStatus): string {
		switch (status) {
			case 'published':
				return $LL.admin_flows_status_published();
			case 'disabled':
				return $LL.admin_flows_status_disabled();
			case 'draft':
			default:
				return $LL.admin_flows_status_draft();
		}
	}

	function getAdminFlowKindLabel(kind: string): string {
		switch (kind) {
			case 'approve':
				return $LL.admin_flows_kind_authorization();
			case 'registration':
			case 'login':
				return getFlowKindLabel($LL, kind);
			case 'account':
				return $LL.admin_flows_palette_account_label();
			default:
				return kind;
		}
	}

	function getActiveAssignmentLabel(flowId: string): string {
		const count = activeAssignmentCounts[flowId] ?? 0;
		const label = $LL.admin_flows_assignment_enabled();
		return count > 1 ? `${label} (${count})` : label;
	}

	function formatDate(seconds: number): string {
		if (!seconds) return '-';
		return new Intl.DateTimeFormat(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		}).format(new Date(seconds * 1000));
	}

	function openImportModal() {
		importModalOpen = true;
		importError = '';
		importValidationRan = false;
		importValidationIssues = [];
	}

	function closeImportModal() {
		if (importing) return;
		importModalOpen = false;
		importError = '';
		importValidationRan = false;
		importValidationIssues = [];
	}

	async function importFlowJson() {
		importing = true;
		importError = '';
		importValidationRan = false;
		importValidationIssues = [];
		try {
			if (new Blob([importJson]).size > MAX_IMPORT_JSON_BYTES) {
				throw new Error($LL.admin_flows_import_failed());
			}
			const parsed = JSON.parse(importJson) as FlowRuntimeContractPackage;
			const validation = await adminFlowsAPI.validate('import-preview', { contract: parsed });
			importValidationRan = true;
			importValidationIssues = validation.issues;
			if (!validation.valid) {
				return;
			}
			const response = await adminFlowsAPI.import(parsed);
			importModalOpen = false;
			importJson = '';
			await loadFlows();
			await goto(`/admin/flows/${response.flow_id}/edit`);
		} catch (error) {
			importError = error instanceof Error ? error.message : $LL.admin_flows_import_failed();
		} finally {
			importing = false;
		}
	}

	async function handleImportFile(event: Event) {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		const file = input.files?.[0];
		if (!file) return;
		importError = '';
		try {
			if (file.size > MAX_IMPORT_JSON_BYTES) {
				throw new Error($LL.admin_flows_import_failed());
			}
			importJson = await file.text();
		} catch (error) {
			importError = error instanceof Error ? error.message : $LL.admin_flows_import_failed();
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_flows_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader title={$LL.admin_flows_title()} description={$LL.admin_flows_description()}>
		{#snippet actions()}
			<a href="/admin/consent-policies" class="btn btn-secondary">
				<i class="i-ph-clipboard-text" aria-hidden="true"></i>
				{$LL.admin_flows_consent_policies()}
			</a>
			<a href="/admin/field-mapping/field-mapping-sets" class="btn btn-secondary">
				<i class="i-ph-graph" aria-hidden="true"></i>
				{$LL.admin_flows_field_mapping()}
			</a>
			<button type="button" class="btn btn-secondary" onclick={openImportModal}>
				<i class="i-ph-upload-simple" aria-hidden="true"></i>
				{$LL.admin_flows_import_json()}
			</button>
			<a href="/admin/flows/new" class="btn btn-primary">
				<i class="i-ph-plus" aria-hidden="true"></i>
				{$LL.admin_flows_new_flow()}
			</a>
		{/snippet}
	</AdminPageHeader>

	<AdminSection
		title={$LL.admin_flows_list_title()}
		description={$LL.admin_flows_list_description()}
	>
		<div class="flow-list">
			{#if flowsLoading}
				<div class="flow-empty" role="status">{$LL.admin_flows_loading()}</div>
			{:else if flowsError}
				<div class="flow-empty flow-empty--error" role="alert">
					{$LL.admin_flows_load_error()}
					<span>{flowsError}</span>
				</div>
			{:else if flows.length > 0}
				{#each flows as flow (flow.id)}
					<a class="flow-row" href={`/admin/flows/${flow.id}`}>
						<div class="flow-row__main">
							<div class="flow-row__icon">
								<i class="i-ph-flow-arrow" aria-hidden="true"></i>
							</div>
							<div>
								<div class="flow-row__title">
									<strong>{flow.display_name || flow.name || flow.slug}</strong>
									<span class="status-badge" data-state={flow.status}>
										{getAdminFlowStatusLabel(flow.status)}
									</span>
									{#if activeAssignmentCounts[flow.id]}
										<span class="status-badge" data-state="assigned">
											{getActiveAssignmentLabel(flow.id)}
										</span>
									{/if}
								</div>
								<p>{getSavedFlowDescription($LL, flow)}</p>
							</div>
						</div>
						<div class="flow-row__meta">
							<span>{getAdminFlowKindLabel(flow.kind)}</span>
							<span>{flow.slug}</span>
							<span>{formatDate(flow.updated_at)}</span>
						</div>
						<i class="i-ph-caret-right flow-row__arrow" aria-hidden="true"></i>
					</a>
				{/each}
			{:else}
				<div class="flow-empty">{$LL.admin_flows_saved_flows_empty()}</div>
			{/if}
		</div>
	</AdminSection>
</AdminPageShell>

<Modal
	open={importModalOpen}
	onClose={closeImportModal}
	title={$LL.admin_flows_import_modal_title()}
	size="lg"
>
	<div class="import-form">
		<p>{$LL.admin_flows_import_modal_description()}</p>
		<label class="file-input">
			<span>{$LL.admin_flows_import_json()}</span>
			<input type="file" accept="application/json,.json" onchange={handleImportFile} />
		</label>
		<textarea
			class="admin-input"
			rows="14"
			bind:value={importJson}
			placeholder="JSON"
			spellcheck="false"
		></textarea>
		{#if importError}
			<div class="flow-empty flow-empty--error" role="alert">{importError}</div>
		{/if}
		{#if importValidationRan}
			<div class="import-validation" data-valid={importValidationIssues.length === 0}>
				<strong>
					{importValidationIssues.length === 0
						? $LL.admin_flows_validation_valid()
						: $LL.admin_flows_validation_failed()}
				</strong>
				{#if importValidationIssues.length > 0}
					<ul>
						{#each importValidationIssues as issue, index (`${issue.code}-${issue.path ?? ''}-${index}`)}
							<li data-level={issue.level}>
								<code>{issue.code}</code>
								<span>{issue.message}</span>
								{#if issue.node_id || issue.edge_id || issue.path}
									<small>{issue.node_id || issue.edge_id || issue.path}</small>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<button type="button" class="btn btn-secondary" onclick={closeImportModal} disabled={importing}>
			{$LL.admin_flows_cancel()}
		</button>
		<button
			type="button"
			class="btn btn-primary"
			onclick={importFlowJson}
			disabled={importing || !importJson.trim()}
		>
			{importing ? $LL.admin_flows_importing() : $LL.admin_flows_import_json()}
		</button>
	{/snippet}
</Modal>

<style>
	.btn {
		min-height: var(--control-height, 36px);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 0 13px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		font-weight: 800;
		text-decoration: none;
		cursor: pointer;
	}

	.btn:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.btn-primary {
		border-color: var(--button-primary-bg, var(--color-accent));
		background: var(--button-primary-bg, var(--color-accent));
		color: var(--button-primary-color, var(--color-accent-contrast));
	}

	.btn-primary:hover {
		color: var(--button-primary-color, var(--color-accent-contrast));
	}

	.btn:disabled {
		opacity: 0.68;
		cursor: wait;
	}

	.flow-list {
		display: grid;
		gap: 12px;
	}

	.flow-empty {
		padding: 18px;
		border: 1px dashed var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-text-muted);
		font-size: 0.88rem;
	}

	.flow-empty span {
		display: block;
		margin-top: 4px;
		font-size: 0.78rem;
	}

	.flow-empty--error {
		border-color: color-mix(in srgb, var(--color-danger) 54%, var(--color-border));
		color: var(--color-danger);
	}

	.import-form {
		display: grid;
		gap: 12px;
	}

	.import-form p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
		line-height: 1.55;
	}

	.file-input {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		width: fit-content;
		min-height: var(--control-height, 36px);
		padding: 0 13px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.84rem;
		font-weight: 800;
		cursor: pointer;
	}

	.file-input:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.file-input input {
		display: none;
	}

	.import-validation {
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-danger) 9%, var(--color-surface));
		color: var(--color-text);
		font-size: 0.84rem;
	}

	.import-validation[data-valid='true'] {
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 9%, var(--color-surface));
	}

	.import-validation ul {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.import-validation li {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 8px;
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
	}

	.import-validation li[data-level='warning'] {
		border-color: color-mix(in srgb, var(--color-warning) 44%, var(--color-border));
	}

	.import-validation code {
		color: var(--color-text-muted);
		font-size: 0.74rem;
	}

	.import-validation small {
		grid-column: 1 / -1;
		color: var(--color-text-muted);
		font-size: 0.72rem;
	}

	.admin-input {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		line-height: 1.5;
		resize: vertical;
	}

	.flow-row {
		min-height: 112px;
		display: grid;
		grid-template-columns: minmax(280px, 1fr) minmax(220px, auto) auto;
		align-items: center;
		gap: 18px;
		padding: 18px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-text);
		text-decoration: none;
		transition:
			border-color 120ms ease,
			background 120ms ease,
			transform 120ms ease;
	}

	.flow-row:hover {
		border-color: var(--color-accent);
		background: var(--color-surface-muted);
		transform: translateY(-1px);
	}

	.flow-row__main {
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
	}

	.flow-row__icon {
		width: 42px;
		height: 42px;
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
		font-size: 1.3rem;
	}

	.flow-row__title {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.flow-row__title strong {
		font-size: 1rem;
	}

	.flow-row p {
		margin: 5px 0 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
		line-height: 1.55;
	}

	.flow-row__meta {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		flex-wrap: wrap;
	}

	.flow-row__meta span,
	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 9px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-text-muted);
		font-size: 0.72rem;
		font-weight: 800;
	}

	.status-badge[data-state='preview'] {
		border-color: color-mix(in srgb, var(--color-success) 55%, transparent);
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
		color: var(--color-success);
	}

	.status-badge[data-state='planning'] {
		border-color: color-mix(in srgb, var(--color-warning) 55%, transparent);
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
		color: var(--color-warning);
	}

	.status-badge[data-state='draft'] {
		border-color: color-mix(in srgb, var(--color-info, var(--color-accent)) 55%, transparent);
		background: color-mix(in srgb, var(--color-info, var(--color-accent)) 12%, transparent);
		color: var(--color-info, var(--color-accent));
	}

	.status-badge[data-state='published'] {
		border-color: color-mix(in srgb, var(--color-success) 55%, transparent);
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
		color: var(--color-success);
	}

	.status-badge[data-state='assigned'] {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		color: var(--color-accent);
	}

	.status-badge[data-state='disabled'] {
		border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.flow-row__arrow {
		color: var(--color-text-muted);
	}

	@media (max-width: 980px) {
		.flow-row {
			grid-template-columns: 1fr;
		}

		.flow-row__arrow {
			display: none;
		}

		.flow-row__meta {
			justify-content: flex-start;
		}
	}
</style>
