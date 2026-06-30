<script lang="ts">
	import { page } from '$app/stores';
	import { LL } from '$i18n/i18n-svelte';
	import {
		getFlowDestinationLabel,
		getFlowTemplateText,
		getLocalizedContractSummary,
		getLocalizedFlowNodes
	} from '$lib/admin/flow-i18n';
	import {
		adminFlowsAPI,
		type AdminFlow,
		type AdminFlowStatus,
		type FlowAssignment,
		type FlowVersion
	} from '$lib/api/admin-flows';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import {
		formatLoginUiRuntimeContractPreview,
		getNewFlowTemplate
	} from '$lib/admin/new-flow-templates';
	import { onMount } from 'svelte';

	const flowId = $derived($page.params.id ?? '');
	const flow = $derived(getNewFlowTemplate(flowId));
	const flowText = $derived(flow ? getFlowTemplateText($LL, flow) : null);
	const flowStatusLabel = $derived(
		flow
			? flow.status === 'preview'
				? $LL.admin_flows_status_preview()
				: $LL.admin_flows_status_planning()
			: ''
	);
	const flowDestinationLabel = $derived(
		flow ? getFlowDestinationLabel($LL, flow.destinationType) : ''
	);
	const flowNodes = $derived(flow ? getLocalizedFlowNodes($LL, flow) : []);
	const contractSummary = $derived(
		flow ? getLocalizedContractSummary($LL, flow.contractSummary) : []
	);
	const contractJson = $derived(flow ? formatLoginUiRuntimeContractPreview(flow) : '');

	let savedFlow = $state<AdminFlow | null>(null);
	let assignments = $state<FlowAssignment[]>([]);
	let versions = $state<FlowVersion[]>([]);
	let savedContractJson = $state('');
	let loadError = $state('');
	let loading = $state(true);
	let publishing = $state(false);
	let actionError = $state('');

	onMount(() => {
		void loadSavedFlow();
	});

	async function loadSavedFlow() {
		if (!flowId) return;
		loading = true;
		loadError = '';
		actionError = '';
		try {
			const [detail, versionResponse, exported] = await Promise.all([
				adminFlowsAPI.get(flowId),
				adminFlowsAPI.versions(flowId),
				adminFlowsAPI.export(flowId)
			]);
			savedFlow = detail.flow;
			assignments = detail.assignments;
			versions = versionResponse.versions;
			savedContractJson = JSON.stringify(exported, null, 2);
		} catch (error) {
			savedFlow = null;
			assignments = [];
			versions = [];
			savedContractJson = '';
			loadError = error instanceof Error ? error.message : $LL.admin_flows_load_error();
		} finally {
			loading = false;
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
				return $LL.admin_flows_kind_registration();
			case 'login':
				return $LL.admin_flows_kind_login();
			case 'account':
				return $LL.admin_flows_palette_account_label();
			default:
				return kind;
		}
	}

	function formatDate(seconds: number): string {
		if (!seconds) return '-';
		return new Intl.DateTimeFormat(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date(seconds * 1000));
	}

	async function publishFlow() {
		if (!savedFlow) return;
		publishing = true;
		actionError = '';
		try {
			await adminFlowsAPI.publish(savedFlow.id);
			await loadSavedFlow();
		} catch (error) {
			actionError = error instanceof Error ? error.message : $LL.admin_flows_publish_failed();
		} finally {
			publishing = false;
		}
	}

	function downloadJson() {
		if (!savedFlow || !savedContractJson) return;
		const blob = new Blob([savedContractJson], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = `${savedFlow.slug || savedFlow.id}.flow.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title
		>{savedFlow
			? $LL.admin_flows_detail_page_title({
					title: savedFlow.display_name || savedFlow.name || savedFlow.slug
				})
			: flowText
				? $LL.admin_flows_detail_page_title({ title: flowText.title })
				: $LL.admin_flows_detail_fallback_page_title()}</title
	>
</svelte:head>

<AdminPageShell>
	{#if loading}
		<AdminPageHeader title={$LL.admin_flows_title()} description={$LL.admin_flows_loading()}>
			{#snippet actions()}
				<a href="/admin/flows" class="btn btn-secondary">
					<i class="i-ph-arrow-left" aria-hidden="true"></i>
					{$LL.admin_flows_back_to_list()}
				</a>
			{/snippet}
		</AdminPageHeader>
	{:else if savedFlow}
		{@const currentFlow = savedFlow}
		<AdminPageHeader
			title={currentFlow.display_name || currentFlow.name || currentFlow.slug}
			description={currentFlow.description || currentFlow.slug}
			eyebrow={getAdminFlowKindLabel(currentFlow.kind)}
		>
			{#snippet titleAccessory()}
				<span class="status-badge" data-state={currentFlow.status}>
					{getAdminFlowStatusLabel(currentFlow.status)}
				</span>
			{/snippet}
			{#snippet actions()}
				<a href="/admin/flows" class="btn btn-secondary">
					<i class="i-ph-arrow-left" aria-hidden="true"></i>
					{$LL.admin_flows_back_to_list()}
				</a>
				<button type="button" class="btn btn-secondary" onclick={downloadJson}>
					<i class="i-ph-download-simple" aria-hidden="true"></i>
					{$LL.admin_flows_export_json()}
				</button>
				<button type="button" class="btn btn-secondary" onclick={publishFlow} disabled={publishing}>
					<i class="i-ph-upload-simple" aria-hidden="true"></i>
					{publishing ? $LL.admin_flows_publishing() : $LL.admin_flows_publish()}
				</button>
				<a href={`/admin/flows/${currentFlow.id}/edit`} class="btn btn-primary">
					<i class="i-ph-flow-arrow" aria-hidden="true"></i>
					{$LL.admin_flows_open_editor()}
				</a>
			{/snippet}
		</AdminPageHeader>

		{#if actionError}
			<div class="page-alert" role="alert">{actionError}</div>
		{/if}

		<AdminSection
			title={$LL.admin_flows_details_title()}
			description={$LL.admin_flows_details_description()}
		>
			<div class="detail-grid">
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_slug()}</span>
					<strong>{currentFlow.slug}</strong>
				</div>
				<div class="detail-item">
					<span>{$LL.admin_flows_contract_label_flow_kind()}</span>
					<strong>{getAdminFlowKindLabel(currentFlow.kind)}</strong>
				</div>
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_status()}</span>
					<strong>{getAdminFlowStatusLabel(currentFlow.status)}</strong>
				</div>
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_updated()}</span>
					<strong>{formatDate(currentFlow.updated_at)}</strong>
				</div>
			</div>
		</AdminSection>

		<div class="contract-panels">
			<AdminSection
				title={$LL.admin_flows_runtime_contract_title()}
				description={$LL.admin_flows_runtime_contract_description()}
			>
				<div class="contract-preview">
					<div class="contract-preview__header">
						<span>{$LL.admin_flows_runtime_contract_preview_label()}</span>
						<code>JSON</code>
					</div>
					<pre class="contract-block">{savedContractJson}</pre>
				</div>
			</AdminSection>

			<AdminSection title={$LL.admin_flows_versions_title()}>
				<div class="decision-list">
					{#if versions.length === 0}
						<div><strong>{$LL.admin_flows_versions_empty()}</strong></div>
					{:else}
						{#each versions as version (version.id)}
							<div>
								<span>v{version.version_number}</span>
								<strong>{formatDate(version.published_at)}</strong>
							</div>
						{/each}
					{/if}
				</div>
			</AdminSection>
		</div>

		<AdminSection title={$LL.admin_flows_assignments_title()}>
			<div class="decision-list">
				{#if assignments.length === 0}
					<div><strong>{$LL.admin_flows_assignments_empty()}</strong></div>
				{:else}
					{#each assignments as assignment (assignment.id)}
						<div>
							<span>{assignment.flow_kind}</span>
							<strong>
								{assignment.target_id ||
									(assignment.target_type === 'tenant'
										? $LL.admin_flows_assignment_target_tenant()
										: assignment.target_type)}
							</strong>
						</div>
					{/each}
				{/if}
			</div>
		</AdminSection>
	{:else if !flow}
		<AdminPageHeader
			title={$LL.admin_flows_not_found_title()}
			description={loadError || $LL.admin_flows_not_found_description()}
		>
			{#snippet actions()}
				<a href="/admin/flows" class="btn btn-secondary">
					<i class="i-ph-arrow-left" aria-hidden="true"></i>
					{$LL.admin_flows_back_to_list()}
				</a>
			{/snippet}
		</AdminPageHeader>
	{:else if flow && flowText}
		<AdminPageHeader
			title={flowText.title}
			description={flowText.description}
			eyebrow={flow.protocol}
		>
			{#snippet titleAccessory()}
				<span class="status-badge" data-state={flow.status}>
					{flowStatusLabel}
				</span>
			{/snippet}
			{#snippet actions()}
				<a href="/admin/flows" class="btn btn-secondary">
					<i class="i-ph-arrow-left" aria-hidden="true"></i>
					{$LL.admin_flows_back_to_list()}
				</a>
				<a href={`/admin/flows/${flow.id}/edit`} class="btn btn-primary">
					<i class="i-ph-flow-arrow" aria-hidden="true"></i>
					{$LL.admin_flows_open_editor()}
				</a>
			{/snippet}
		</AdminPageHeader>

		<AdminSection
			title={$LL.admin_flows_details_title()}
			description={$LL.admin_flows_details_description()}
		>
			<div class="detail-grid">
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_entry()}</span>
					<strong>{flowText.primaryEntry}</strong>
				</div>
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_destination()}</span>
					<strong>{flowDestinationLabel}</strong>
				</div>
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_mapping()}</span>
					<strong>{flowText.mappingSet}</strong>
				</div>
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_consent_policy()}</span>
					<strong>{flowText.consentPolicy}</strong>
				</div>
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_consent_statement()}</span>
					<strong>{flowText.consentStatement}</strong>
				</div>
				<div class="detail-item">
					<span>{$LL.admin_flows_detail_output()}</span>
					<strong>{flowText.primaryOutput}</strong>
				</div>
			</div>
		</AdminSection>

		<AdminSection
			title={$LL.admin_flows_configuration_links_title()}
			description={$LL.admin_flows_configuration_links_description()}
		>
			<div class="link-grid">
				<a href="/admin/field-mapping/field-mapping-sets" class="link-card">
					<i class="i-ph-graph" aria-hidden="true"></i>
					<div>
						<strong>{$LL.admin_flows_link_field_mapping_set_title()}</strong>
						<span>{$LL.admin_flows_link_field_mapping_set_description()}</span>
					</div>
				</a>
				<a href="/admin/consent-statements" class="link-card">
					<i class="i-ph-list-checks" aria-hidden="true"></i>
					<div>
						<strong>{$LL.admin_flows_link_consent_statement_title()}</strong>
						<span>{$LL.admin_flows_link_consent_statement_description()}</span>
					</div>
				</a>
				<a href="/admin/consent-policies" class="link-card">
					<i class="i-ph-clipboard-text" aria-hidden="true"></i>
					<div>
						<strong>{$LL.admin_flows_link_consent_policy_title()}</strong>
						<span>{$LL.admin_flows_link_consent_policy_description()}</span>
					</div>
				</a>
			</div>
		</AdminSection>

		<div class="contract-panels">
			<AdminSection
				title={$LL.admin_flows_runtime_contract_title()}
				description={$LL.admin_flows_runtime_contract_description()}
			>
				<div class="contract-layout">
					<dl class="contract-summary">
						{#each contractSummary as item (item.label)}
							<div>
								<dt>{item.label}</dt>
								<dd>{item.value}</dd>
							</div>
						{/each}
					</dl>
					<div class="contract-preview">
						<div class="contract-preview__header">
							<span>{$LL.admin_flows_runtime_contract_preview_label()}</span>
							<code>JSON</code>
						</div>
						<pre class="contract-block">{contractJson}</pre>
					</div>
				</div>
			</AdminSection>

			<AdminSection
				title={$LL.admin_flows_output_decision_title()}
				description={$LL.admin_flows_output_decision_description()}
			>
				<div class="decision-list">
					<div>
						<span>{$LL.admin_flows_output_decision_user_action()}</span>
						<strong>{flowText.userAction}</strong>
					</div>
					<div>
						<span>{$LL.admin_flows_output_decision_recorded_state()}</span>
						<strong>{flowText.recordedState}</strong>
					</div>
					<div>
						<span>{$LL.admin_flows_detail_output()}</span>
						<strong>{flowText.primaryOutput}</strong>
					</div>
				</div>
			</AdminSection>
		</div>

		<AdminSection
			title={$LL.admin_flows_steps_title()}
			description={$LL.admin_flows_steps_description()}
		>
			<div class="step-list">
				{#each flowNodes as node, index (node.id)}
					<div class="step-row">
						<div class="step-row__number">{index + 1}</div>
						<div class="step-row__content">
							<div class="step-row__heading">
								<i class={node.icon} aria-hidden="true"></i>
								<strong>{node.label}</strong>
							</div>
							<p>{node.description}</p>
						</div>
					</div>
				{/each}
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

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

	.page-alert {
		margin-bottom: 14px;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 54%, var(--color-border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		color: var(--color-danger);
		font-size: 0.86rem;
		font-weight: 800;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 9px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
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

	.status-badge[data-state='disabled'] {
		border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.detail-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
		gap: 12px;
	}

	.detail-item {
		min-height: 86px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.detail-item span,
	.detail-item strong {
		display: block;
	}

	.detail-item span {
		color: var(--color-text-muted);
		font-size: 0.76rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.detail-item strong {
		margin-top: 8px;
		color: var(--color-text);
		line-height: 1.45;
	}

	.link-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 12px;
	}

	.link-card {
		min-height: 92px;
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-text);
		text-decoration: none;
	}

	.link-card:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.link-card i {
		width: 34px;
		height: 34px;
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
		font-size: 1.15rem;
	}

	.link-card strong,
	.link-card span {
		display: block;
	}

	.link-card span {
		margin-top: 5px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		line-height: 1.55;
	}

	.contract-panels {
		display: grid;
		grid-template-columns: minmax(360px, 1.35fr) minmax(280px, 0.65fr);
		gap: 18px;
		align-items: start;
	}

	.contract-layout {
		display: grid;
		grid-template-columns: minmax(260px, 0.8fr) minmax(360px, 1.2fr);
		gap: 16px;
		align-items: start;
	}

	.contract-summary {
		display: grid;
		gap: 10px;
	}

	.contract-summary div {
		padding: 13px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.contract-summary dt {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.74rem;
		font-weight: 800;
	}

	.contract-summary dd {
		margin: 5px 0 0;
		color: var(--color-text);
		font-weight: 700;
	}

	.contract-block {
		max-height: 420px;
		margin: 0;
		padding: 15px;
		overflow: auto;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.78rem;
		line-height: 1.55;
		white-space: pre-wrap;
	}

	.contract-preview {
		min-width: 0;
		display: grid;
		gap: 8px;
	}

	.contract-preview__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		color: var(--color-text-muted);
		font-size: 0.76rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.contract-preview__header code {
		padding: 3px 7px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: var(--color-surface);
		color: var(--color-text-muted);
		font-size: 0.68rem;
		text-transform: none;
	}

	.decision-list {
		display: grid;
		gap: 10px;
	}

	.decision-list div {
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.decision-list span,
	.decision-list strong {
		display: block;
	}

	.decision-list span {
		color: var(--color-text-muted);
		font-size: 0.74rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.decision-list strong {
		margin-top: 6px;
		color: var(--color-text);
		line-height: 1.48;
	}

	.step-list {
		display: grid;
		gap: 10px;
	}

	.step-row {
		display: grid;
		grid-template-columns: 34px 1fr;
		gap: 12px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.step-row__number {
		width: 34px;
		height: 34px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
		font-weight: 900;
	}

	.step-row__heading {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--color-text);
	}

	.step-row__heading i {
		color: var(--color-accent);
		font-size: 1rem;
	}

	.step-row p {
		margin: 5px 0 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
		line-height: 1.55;
	}

	@media (max-width: 900px) {
		.contract-panels,
		.contract-layout {
			grid-template-columns: 1fr;
		}
	}
</style>
