<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingReviewTask
	} from '$lib/api/admin-identity-mapping';

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
			label: 'Conflicts',
			description: 'Multiple trusted sources claim incompatible values for the same target.'
		},
		{
			id: 'missing_mappings',
			label: 'Missing Mappings',
			description: 'Imported fields or outbound requirements do not have a safe target yet.'
		},
		{
			id: 'linking_decisions',
			label: 'Linking Decisions',
			description: 'Identity candidates need step-up, admin approval, or explicit denial.'
		},
		{
			id: 'consent_required',
			label: 'Consent Required',
			description: 'Destination release needs consent, version upgrade, or purpose review.'
		},
		{
			id: 'lifecycle_actions',
			label: 'Lifecycle Actions',
			description: 'Provisioning or deprovisioning signals need protected-account review.'
		},
		{
			id: 'activation_blockers',
			label: 'Activation Blockers',
			description: 'Policy compile or activation cannot proceed until these items close.'
		}
	];

	const fallbackItems: ResolutionItem[] = [
		{
			id: 'res-001',
			category: 'missing_mappings',
			title: 'SAML User.UserType has no approved release target',
			source: 'SAML Salesforce columns',
			impact: 'OIDC destination preview omits the claim until a profile owner confirms the target.',
			severity: 'medium',
			status: 'open'
		},
		{
			id: 'res-002',
			category: 'consent_required',
			title: 'Academic affiliation bundle requires consent version upgrade',
			source: 'Destination Profile / SAML assertion',
			impact: 'Attribute release challenge is required before release to the selected SP.',
			severity: 'high',
			status: 'needs_approval'
		},
		{
			id: 'res-003',
			category: 'linking_decisions',
			title: 'OIDC iss + sub candidate cannot hard-match existing SAML NameID',
			source: 'Identity bridge preview',
			impact: 'Login remains fail-closed unless step-up or admin approval links the candidate.',
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
			loadError = error instanceof Error ? error.message : 'Failed to load review tasks';
		} finally {
			isLoading = false;
		}
	}

	async function transitionResolutionItem(item: ResolutionItem, status: 'resolved' | 'dismissed') {
		if (loadError) {
			actionState = { ...actionState, [item.id]: 'Preview item cannot be changed' };
			return;
		}
		busyItemId = item.id;
		actionState = {
			...actionState,
			[item.id]: status === 'resolved' ? 'Resolving item' : 'Dismissing item'
		};
		try {
			await adminIdentityMappingAPI.transitionReviewTask(item.id, {
				status,
				reasonCodes: [status === 'resolved' ? 'operator_resolved' : 'operator_dismissed']
			});
			actionState = {
				...actionState,
				[item.id]: status === 'resolved' ? 'Resolved' : 'Dismissed'
			};
			await loadReviewTasks();
		} catch (error) {
			actionState = {
				...actionState,
				[item.id]: error instanceof Error ? error.message : 'Action failed'
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
				'Review required before this mapping decision can be closed safely.',
			severity: priorityToSeverity(task.priority),
			status: statusToResolutionStatus(task.status)
		};
	}

	function taskTypeToCategory(taskType: string): ResolutionCategory {
		const normalized = taskType.toLowerCase();
		if (normalized.includes('conflict')) return 'conflicts';
		if (normalized.includes('consent') || normalized.includes('release')) return 'consent_required';
		if (normalized.includes('link') || normalized.includes('identity')) return 'linking_decisions';
		if (normalized.includes('lifecycle') || normalized.includes('provision')) return 'lifecycle_actions';
		if (normalized.includes('activation') || normalized.includes('compile')) return 'activation_blockers';
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
	<title>Mapping Resolution Center - Authrim Admin</title>
</svelte:head>

<div class="resolution-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/identity-mapping">Back to Identity Mapping</a>
			<p class="eyebrow">Identity Mapping</p>
			<h1>Mapping Resolution Center</h1>
			<p class="summary">
				Resolve conflicts, missing mappings, linking decisions, consent blockers, protected
				lifecycle actions, and activation blockers that automatic mapping cannot close safely.
			</p>
		</div>
		<div class="status-panel">
			<strong>{loadError ? 'Preview fallback' : 'Review task feed'}</strong>
			<span>
				{#if isLoading}
					Loading unresolved mapping decisions.
				{:else if loadError}
					{loadError}. Showing safe preview examples.
				{:else}
					{reviewTasks.length} unresolved item{reviewTasks.length === 1 ? '' : 's'} loaded from the
					resolution feed.
				{/if}
			</span>
		</div>
	</div>

	<div class="resolution-layout">
		<nav class="category-list" aria-label="Resolution categories">
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
					<strong>Loading items</strong>
					<span>Fetching unresolved conflicts, missing mappings, and approval blockers.</span>
				</div>
			{:else if visibleItems.length === 0}
				<div class="empty-state">
					<strong>No unresolved items</strong>
					<span>This category has no open resolution items.</span>
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
										Resolve
									</button>
									<button
										type="button"
										onclick={() => transitionResolutionItem(item, 'dismissed')}
										disabled={busyItemId === item.id}
									>
										Dismiss
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
</div>

<style>
	.resolution-page {
		display: grid;
		gap: 18px;
	}

	.page-heading,
	.panel-heading,
	.resolution-item {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.back-link {
		display: inline-flex;
		margin-bottom: 12px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.eyebrow {
		margin: 0 0 4px;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	h1,
	h2,
	h3,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
		line-height: 1.2;
	}

	h2 {
		max-width: 760px;
		color: var(--text-primary);
		font-size: 17px;
		line-height: 1.35;
	}

	h3 {
		color: var(--text-primary);
		font-size: 16px;
		line-height: 1.35;
	}

	.summary {
		max-width: 760px;
		margin-top: 8px;
		color: var(--text-secondary);
		font-size: 14px;
		line-height: 1.5;
	}

	.status-panel,
	.category-list,
	.resolution-panel,
	.empty-state,
	.resolution-item {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		min-width: 280px;
		display: grid;
		gap: 4px;
		padding: 12px;
	}

	.status-panel strong,
	.empty-state strong {
		color: var(--text-primary);
		font-size: 13px;
	}

	.status-panel span,
	.empty-state span,
	.resolution-item span {
		color: var(--text-secondary);
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
		border-bottom: 1px solid var(--border-color);
		color: var(--text-secondary);
		background: transparent;
		font-weight: 700;
		text-align: left;
	}

	.category-list button:last-child {
		border-bottom: 0;
	}

	.category-list button.active {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.category-list strong,
	.item-meta strong {
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--bg-muted);
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
		color: var(--text-muted);
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
		min-height: 32px;
		padding: 0 10px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		font-size: 12px;
		font-weight: 800;
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
		border-left-color: #22c55e;
	}

	.severity-medium {
		border-left-color: #f59e0b;
	}

	.severity-high {
		border-left-color: #ef4444;
	}

	@media (max-width: 900px) {
		.page-heading,
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
