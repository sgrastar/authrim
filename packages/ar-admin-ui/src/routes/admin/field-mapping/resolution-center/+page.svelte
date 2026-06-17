<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingReviewTask
	} from '$lib/api/admin-identity-mapping';
	import { AdminPageHeader, AdminPageShell } from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	type ResolutionCategory =
		| 'conflicts'
		| 'missing_mappings'
		| 'linking_decisions'
		| 'consent_required'
		| 'lifecycle_actions'
		| 'activation_blockers';

	interface ResolutionItem {
		id: string;
		category: ResolutionCategory;
		title: string;
		source: string;
		impact: string;
		severity: 'low' | 'medium' | 'high';
		status: 'open' | 'blocked' | 'needs_approval';
	}

	const categories: Array<{ id: ResolutionCategory; label: string; description: string }> = [
		{
			id: 'conflicts',
			label: $LL.admin_identity_mapping_resolution_conflicts(),
			description: $LL.admin_identity_mapping_resolution_conflicts_desc()
		},
		{
			id: 'missing_mappings',
			label: $LL.admin_identity_mapping_resolution_missing_mappings(),
			description: $LL.admin_identity_mapping_resolution_missing_mappings_desc()
		},
		{
			id: 'linking_decisions',
			label: $LL.admin_identity_mapping_resolution_linking_decisions(),
			description: $LL.admin_identity_mapping_resolution_linking_decisions_desc()
		},
		{
			id: 'consent_required',
			label: $LL.admin_identity_mapping_resolution_consent_required(),
			description: $LL.admin_identity_mapping_resolution_consent_required_desc()
		},
		{
			id: 'lifecycle_actions',
			label: $LL.admin_identity_mapping_resolution_lifecycle_actions(),
			description: $LL.admin_identity_mapping_resolution_lifecycle_actions_desc()
		},
		{
			id: 'activation_blockers',
			label: $LL.admin_identity_mapping_resolution_activation_blockers(),
			description: $LL.admin_identity_mapping_resolution_activation_blockers_desc()
		}
	];

	const fallbackItems: ResolutionItem[] = [
		{
			id: 'res-001',
			category: 'missing_mappings',
			title: $LL.admin_identity_mapping_resolution_fallback_missing_title(),
			source: $LL.admin_identity_mapping_resolution_fallback_missing_source(),
			impact: $LL.admin_identity_mapping_resolution_fallback_missing_impact(),
			severity: 'medium',
			status: 'open'
		},
		{
			id: 'res-002',
			category: 'consent_required',
			title: $LL.admin_identity_mapping_resolution_fallback_consent_title(),
			source: $LL.admin_identity_mapping_resolution_fallback_consent_source(),
			impact: $LL.admin_identity_mapping_resolution_fallback_consent_impact(),
			severity: 'high',
			status: 'needs_approval'
		},
		{
			id: 'res-003',
			category: 'linking_decisions',
			title: $LL.admin_identity_mapping_resolution_fallback_linking_title(),
			source: $LL.admin_identity_mapping_resolution_fallback_linking_source(),
			impact: $LL.admin_identity_mapping_resolution_fallback_linking_impact(),
			severity: 'high',
			status: 'blocked'
		}
	];

	let activeCategory = $state<ResolutionCategory>('missing_mappings');
	let reviewTasks = $state<IdentityMappingReviewTask[]>([]);
	let isLoading = $state(true);
	let loadError = $state<string | null>(null);
	let busyItemId = $state<string | null>(null);
	let actionState = $state<Record<string, string>>({});

	onMount(() => {
		void loadReviewTasks();
	});

	async function loadReviewTasks() {
		isLoading = true;
		loadError = null;
		try {
			const [openResult, inReviewResult] = await Promise.all([
				adminIdentityMappingAPI.listReviewTasks({ status: 'open', limit: 100 }),
				adminIdentityMappingAPI.listReviewTasks({ status: 'in_review', limit: 100 })
			]);
			reviewTasks = dedupeReviewTasks([...openResult.reviewTasks, ...inReviewResult.reviewTasks]);
		} catch (error) {
			loadError =
				error instanceof Error
					? error.message
					: $LL.admin_identity_mapping_resolution_load_failed();
		} finally {
			isLoading = false;
		}
	}

	async function transitionResolutionItem(item: ResolutionItem, status: 'resolved' | 'dismissed') {
		if (loadError) {
			actionState = {
				...actionState,
				[item.id]: $LL.admin_identity_mapping_resolution_action_preview()
			};
			return;
		}
		busyItemId = item.id;
		actionState = {
			...actionState,
			[item.id]:
				status === 'resolved'
					? $LL.admin_identity_mapping_resolution_resolving()
					: $LL.admin_identity_mapping_resolution_dismissing()
		};
		try {
			await adminIdentityMappingAPI.transitionReviewTask(item.id, {
				status,
				reasonCodes: [status === 'resolved' ? 'operator_resolved' : 'operator_dismissed']
			});
			actionState = {
				...actionState,
				[item.id]:
					status === 'resolved'
						? $LL.admin_identity_mapping_resolution_resolved()
						: $LL.admin_identity_mapping_resolution_dismissed()
			};
			await loadReviewTasks();
		} catch (error) {
			actionState = {
				...actionState,
				[item.id]:
					error instanceof Error
						? error.message
						: $LL.admin_identity_mapping_resolution_action_failed()
			};
		} finally {
			busyItemId = null;
		}
	}

	const resolutionItems = $derived(loadError ? fallbackItems : reviewTasks.map(reviewTaskToItem));
	const visibleItems = $derived(resolutionItems.filter((item) => item.category === activeCategory));
	const categoryCounts = $derived(
		Object.fromEntries(
			categories.map((category) => [
				category.id,
				resolutionItems.filter((item) => item.category === category.id).length
			])
		) as Record<ResolutionCategory, number>
	);

	function reviewTaskToItem(task: IdentityMappingReviewTask): ResolutionItem {
		return {
			id: task.id,
			category: taskTypeToCategory(task.taskType),
			title: getPayloadString(task.payload, 'title') ?? humanizeTaskType(task.taskType),
			source: getPayloadString(task.payload, 'source') ?? task.taskType,
			impact:
				getPayloadString(task.payload, 'riskSummary') ??
				getPayloadString(task.payload, 'impact') ??
				$LL.admin_identity_mapping_resolution_review_required(),
			severity: priorityToSeverity(task.priority),
			status: statusToResolutionStatus(task.status)
		};
	}

	function taskTypeToCategory(taskType: string): ResolutionCategory {
		const normalized = taskType.toLowerCase();
		if (normalized.includes('conflict')) return 'conflicts';
		if (normalized.includes('consent') || normalized.includes('release')) return 'consent_required';
		if (normalized.includes('link') || normalized.includes('identity')) return 'linking_decisions';
		if (normalized.includes('lifecycle') || normalized.includes('provision'))
			return 'lifecycle_actions';
		if (normalized.includes('activation') || normalized.includes('compile'))
			return 'activation_blockers';
		return 'missing_mappings';
	}

	function priorityToSeverity(priority: number): ResolutionItem['severity'] {
		if (priority >= 20) return 'high';
		if (priority >= 10) return 'medium';
		return 'low';
	}

	function statusToResolutionStatus(status: string): ResolutionItem['status'] {
		if (status === 'in_review') return 'needs_approval';
		if (status === 'open') return 'open';
		return 'blocked';
	}

	function dedupeReviewTasks(tasks: IdentityMappingReviewTask[]): IdentityMappingReviewTask[] {
		const byId: Record<string, IdentityMappingReviewTask> = {};
		for (const task of tasks) {
			byId[task.id] = task;
		}
		return Object.values(byId).sort((left, right) => right.priority - left.priority);
	}

	function getPayloadString(payload: Record<string, unknown>, key: string): string | null {
		const value = payload[key];
		return typeof value === 'string' && value.trim().length > 0 ? value : null;
	}

	function humanizeTaskType(taskType: string): string {
		return taskType
			.split('_')
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}
</script>

<svelte:head>
	<title>{$LL.admin_identity_mapping_resolution_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		eyebrow={$LL.admin_identity_mapping_title()}
		title={$LL.admin_identity_mapping_resolution_title()}
		description={$LL.admin_identity_mapping_resolution_description()}
	>
		{#snippet actions()}
			<div class="status-panel">
				<strong>
					{loadError
						? $LL.admin_identity_mapping_editor_preview_fallback()
						: $LL.admin_identity_mapping_resolution_feed()}
				</strong>
				<span>
					{#if isLoading}
						{$LL.admin_identity_mapping_resolution_loading_unresolved()}
					{:else if loadError}
						{loadError}. {$LL.admin_identity_mapping_resolution_fallback_suffix()}
					{:else}
						{$LL.admin_identity_mapping_resolution_loaded({
							count: reviewTasks.length,
							plural: reviewTasks.length === 1 ? '' : 's'
						})}
					{/if}
				</span>
			</div>
		{/snippet}
	</AdminPageHeader>

	<div class="resolution-layout">
		<nav class="category-list" aria-label={$LL.admin_identity_mapping_resolution_categories_aria()}>
			{#each categories as category (category.id)}
				<button
					type="button"
					class:active={activeCategory === category.id}
					onclick={() => (activeCategory = category.id)}
				>
					<span>{category.label}</span>
					<strong>{categoryCounts[category.id]}</strong>
				</button>
			{/each}
		</nav>

		<section class="resolution-panel" aria-live="polite">
			<div class="panel-heading">
				<div>
					<p class="eyebrow">
						{categories.find((category) => category.id === activeCategory)?.label}
					</p>
					<h2>{categories.find((category) => category.id === activeCategory)?.description}</h2>
				</div>
			</div>

			{#if isLoading}
				<div class="empty-state">
					<strong>{$LL.admin_identity_mapping_resolution_loading_items()}</strong>
					<span>{$LL.admin_identity_mapping_resolution_loading_items_desc()}</span>
				</div>
			{:else if visibleItems.length === 0}
				<div class="empty-state">
					<strong>{$LL.admin_identity_mapping_resolution_no_items()}</strong>
					<span>{$LL.admin_identity_mapping_resolution_no_items_desc()}</span>
				</div>
			{:else}
				<div class="item-list">
					{#each visibleItems as item (item.id)}
						<article class="resolution-item severity-{item.severity}">
							<div>
								<p>{item.source}</p>
								<h3>{item.title}</h3>
								<span>{item.impact}</span>
							</div>
							<div class="item-meta">
								<strong>{item.severity}</strong>
								<span>{item.status.replace('_', ' ')}</span>
								<div class="item-actions">
									<button
										type="button"
										onclick={() => transitionResolutionItem(item, 'resolved')}
										disabled={busyItemId === item.id}
									>
										{$LL.admin_identity_mapping_resolution_resolve()}
									</button>
									<button
										type="button"
										onclick={() => transitionResolutionItem(item, 'dismissed')}
										disabled={busyItemId === item.id}
									>
										{$LL.admin_identity_mapping_resolution_dismiss()}
									</button>
								</div>
								{#if actionState[item.id]}
									<span class="action-state">{actionState[item.id]}</span>
								{/if}
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</section>
	</div>
</AdminPageShell>

<style>
	.panel-heading,
	.resolution-item {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.eyebrow {
		margin: 0 0 4px;
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
	}

	h2,
	h3,
	p {
		margin: 0;
	}

	h2 {
		max-width: 760px;
		color: var(--color-text);
		font-size: var(--section-title-size, 1rem);
		line-height: 1.35;
	}

	h3 {
		color: var(--color-text);
		font-size: 16px;
		line-height: 1.35;
	}

	.status-panel,
	.category-list,
	.resolution-panel,
	.empty-state,
	.resolution-item {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
	}

	.status-panel {
		min-width: 280px;
		display: grid;
		gap: 4px;
		padding: 12px;
	}

	.status-panel strong,
	.empty-state strong {
		color: var(--color-text);
		font-size: 13px;
	}

	.status-panel span,
	.empty-state span,
	.resolution-item span {
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 1.45;
	}

	.resolution-layout {
		display: grid;
		grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
		gap: 14px;
	}

	.category-list {
		display: grid;
		align-content: start;
		overflow: hidden;
	}

	.category-list button {
		min-height: 48px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 12px;
		border: 0;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text-muted);
		background: transparent;
		font-weight: 700;
		text-align: left;
	}

	.category-list button:last-child {
		border-bottom: 0;
	}

	.category-list button.active {
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.category-list strong,
	.item-meta strong {
		padding: 3px 8px;
		border-radius: var(--status-badge-radius, 999px);
		background: var(--color-surface-muted);
		font-size: 12px;
	}

	.resolution-panel {
		min-height: 420px;
		padding: 16px;
	}

	.empty-state {
		display: grid;
		gap: 4px;
		margin-top: 16px;
		padding: 18px;
	}

	.item-list {
		display: grid;
		gap: 10px;
		margin-top: 16px;
	}

	.resolution-item {
		padding: 14px;
		border-left-width: 4px;
	}

	.resolution-item p {
		margin-bottom: 4px;
		color: var(--color-text-muted);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
	}

	.item-meta {
		min-width: 128px;
		display: grid;
		justify-items: end;
		gap: 6px;
	}

	.item-meta span {
		text-transform: capitalize;
	}

	.item-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.item-actions button {
		min-height: var(--control-height, 32px);
		padding: 0 10px;
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text);
		background: var(--toolbar-control-bg, var(--color-surface));
		font-size: 12px;
		font-weight: 800;
		cursor: pointer;
	}

	.item-actions button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.action-state {
		max-width: 180px;
		text-align: right;
		text-transform: none;
	}

	.severity-low {
		border-left-color: var(--color-success);
	}

	.severity-medium {
		border-left-color: var(--color-warning);
	}

	.severity-high {
		border-left-color: var(--color-danger);
	}

	@media (max-width: 900px) {
		.resolution-layout,
		.resolution-item {
			display: grid;
		}

		.status-panel {
			min-width: 0;
		}

		.item-meta {
			justify-items: start;
		}

		.item-actions {
			justify-content: flex-start;
		}

		.action-state {
			text-align: left;
		}
	}
</style>
