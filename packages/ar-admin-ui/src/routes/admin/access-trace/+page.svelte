<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { Modal } from '$lib/components';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminAccessTraceAPI,
		type AccessTraceEntry,
		type AccessTraceStats,
		type TimelineDataPoint,
		formatPermission,
		formatTimestamp
	} from '$lib/api/admin-access-trace';

	// =============================================================================
	// State
	// =============================================================================

	let entries = $state<AccessTraceEntry[]>([]);
	let stats = $state<AccessTraceStats | null>(null);
	let timeline = $state<TimelineDataPoint[]>([]);
	let loading = $state(true);
	let error = $state('');

	// Filters
	let selectedPeriod = $state<'1h' | '6h' | '24h' | '7d' | '30d'>('24h');
	let filterDecision = $state<'' | 'allow' | 'deny'>('');
	let filterSubject = $state('');
	let filterPermission = $state('');

	// Pagination
	let currentPage = $state(1);
	let totalPages = $state(1);
	let total = $state(0);
	const pageSize = 50;

	// Detail view
	let selectedEntry = $state<AccessTraceEntry | null>(null);
	let showDetailDialog = $state(false);

	onMount(async () => {
		await settingsContext.initialize();
	});

	// =============================================================================
	// Data Loading
	// =============================================================================

	async function loadData() {
		loading = true;
		error = '';

		try {
			// Calculate time range based on period
			const now = Math.floor(Date.now() / 1000);
			let startTime: number;

			switch (selectedPeriod) {
				case '1h':
					startTime = now - 3600;
					break;
				case '6h':
					startTime = now - 6 * 3600;
					break;
				case '24h':
					startTime = now - 24 * 3600;
					break;
				case '7d':
					startTime = now - 7 * 24 * 3600;
					break;
				case '30d':
					startTime = now - 30 * 24 * 3600;
					break;
				default:
					startTime = now - 24 * 3600;
			}

			// Load entries, stats, and timeline in parallel
			const [entriesResult, statsResult, timelineResult] = await Promise.all([
				adminAccessTraceAPI.listEntries({
					start_time: startTime,
					end_time: now,
					allowed: filterDecision === '' ? undefined : filterDecision === 'allow',
					subject_id: filterSubject || undefined,
					permission: filterPermission || undefined,
					page: currentPage,
					limit: pageSize
				}),
				adminAccessTraceAPI.getStats(selectedPeriod),
				adminAccessTraceAPI.getTimeline(selectedPeriod)
			]);

			entries = entriesResult.entries;
			totalPages = entriesResult.pagination.total_pages;
			total = entriesResult.pagination.total;
			stats = statsResult;
			timeline = timelineResult.data;
		} catch (e) {
			error = e instanceof Error ? e.message : $LL.admin_access_trace_load_failed();
		} finally {
			loading = false;
		}
	}

	// Load on mount and when filters change
	$effect(() => {
		// Track dependencies by using them in a condition
		const _deps = [settingsContext.tenantId, selectedPeriod, filterDecision, currentPage];
		if (_deps) {
			loadData();
		}
	});

	function handleSearch() {
		currentPage = 1;
		loadData();
	}

	function handlePeriodChange(period: '1h' | '6h' | '24h' | '7d' | '30d') {
		selectedPeriod = period;
		currentPage = 1;
	}

	function viewDetail(entry: AccessTraceEntry) {
		selectedEntry = entry;
		showDetailDialog = true;
	}

	function closeDetail() {
		showDetailDialog = false;
		selectedEntry = null;
	}

	// Calculate simple timeline chart bars
	function getTimelineBarHeight(value: number, max: number): number {
		if (max === 0) return 0;
		return Math.max(2, (value / max) * 100);
	}

	function getTimelineMax(): number {
		return Math.max(...timeline.map((d) => d.total), 1);
	}

	function formatDecision(allowed: boolean): string {
		return allowed ? $LL.admin_access_trace_allowed() : $LL.admin_access_trace_denied();
	}

	function formatPeriod(period: string): string {
		switch (period) {
			case '1h':
				return $LL.admin_access_trace_period_1h();
			case '6h':
				return $LL.admin_access_trace_period_6h();
			case '24h':
				return $LL.admin_access_trace_period_24h();
			case '7d':
				return $LL.admin_access_trace_period_7d();
			case '30d':
				return $LL.admin_access_trace_period_30d();
			default:
				return period;
		}
	}

	function formatResolvedViaLocalized(resolvedVia: string[]): string {
		if (!resolvedVia || resolvedVia.length === 0) return $LL.admin_access_trace_unknown();

		return resolvedVia
			.map((value) => {
				switch (value) {
					case 'role':
						return $LL.admin_access_trace_resolved_role();
					case 'rebac':
						return $LL.admin_access_trace_resolved_rebac();
					case 'policy':
						return $LL.admin_access_trace_resolved_policy();
					case 'attribute':
						return $LL.admin_access_trace_resolved_attribute();
					case 'resource_permission':
						return $LL.admin_access_trace_resolved_resource_permission();
					case 'default':
						return $LL.admin_access_trace_resolved_default();
					default:
						return value;
				}
			})
			.join(', ');
	}
</script>

<svelte:head>
	<title>{$LL.admin_access_trace_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_access_trace_title()}</h1>
			<p class="page-description">{$LL.admin_access_trace_description()}</p>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<!-- Stats Overview -->
	{#if stats}
		<div class="stats-grid">
			<div class="stat-card">
				<span class="stat-label">{$LL.admin_access_trace_total_checks()}</span>
				<span class="stat-value">{stats.total.toLocaleString()}</span>
				<span class="stat-period">{formatPeriod(stats.period)}</span>
			</div>
			<div class="stat-card stat-card-success">
				<span class="stat-label">{$LL.admin_access_trace_allowed()}</span>
				<span class="stat-value">{stats.allowed.toLocaleString()}</span>
				<span class="stat-rate">{stats.allow_rate}%</span>
			</div>
			<div class="stat-card stat-card-danger">
				<span class="stat-label">{$LL.admin_access_trace_denied()}</span>
				<span class="stat-value">{stats.denied.toLocaleString()}</span>
				<span class="stat-rate">{100 - stats.allow_rate}%</span>
			</div>
		</div>
	{/if}

	<!-- Timeline Chart -->
	{#if timeline.length > 0}
		<div class="panel">
			<h2 class="panel-title">{$LL.admin_access_trace_timeline()}</h2>
			<div class="timeline-chart">
				{#each timeline as point (point.timestamp)}
					<div class="timeline-bar-group" title={formatTimestamp(point.timestamp)}>
						<div
							class="timeline-bar timeline-bar-allowed"
							style="height: {getTimelineBarHeight(point.allowed, getTimelineMax())}%"
						></div>
						<div
							class="timeline-bar timeline-bar-denied"
							style="height: {getTimelineBarHeight(point.denied, getTimelineMax())}%"
						></div>
					</div>
				{/each}
			</div>
			<div class="timeline-legend">
				<span class="legend-item legend-allowed">{$LL.admin_access_trace_allowed()}</span>
				<span class="legend-item legend-denied">{$LL.admin_access_trace_denied()}</span>
			</div>
		</div>
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="period-tabs">
			{#each ['1h', '6h', '24h', '7d', '30d'] as period (period)}
				<button
					class="period-tab"
					class:active={selectedPeriod === period}
					onclick={() => handlePeriodChange(period as '1h' | '6h' | '24h' | '7d' | '30d')}
				>
					{formatPeriod(period)}
				</button>
			{/each}
		</div>

		<div class="filter-row">
			<div class="form-group">
				<label for="filter-decision" class="form-label">{$LL.admin_access_trace_decision()}</label>
				<select
					id="filter-decision"
					class="form-select"
					bind:value={filterDecision}
					onchange={handleSearch}
				>
					<option value="">{$LL.admin_access_trace_all()}</option>
					<option value="allow">{$LL.admin_access_trace_allowed()}</option>
					<option value="deny">{$LL.admin_access_trace_denied()}</option>
				</select>
			</div>

			<div class="form-group">
				<label for="filter-subject" class="form-label">{$LL.admin_access_trace_subject_id()}</label>
				<input
					id="filter-subject"
					type="text"
					class="form-input"
					placeholder={$LL.admin_access_trace_subject_placeholder()}
					bind:value={filterSubject}
					onkeyup={(e) => e.key === 'Enter' && handleSearch()}
				/>
			</div>

			<div class="form-group">
				<label for="filter-permission" class="form-label"
					>{$LL.admin_access_trace_permission()}</label
				>
				<input
					id="filter-permission"
					type="text"
					class="form-input"
					placeholder={$LL.admin_access_trace_permission_placeholder()}
					bind:value={filterPermission}
					onkeyup={(e) => e.key === 'Enter' && handleSearch()}
				/>
			</div>

			<div class="form-group form-group-action">
				<button class="btn btn-primary" onclick={handleSearch}>
					{$LL.admin_access_trace_search()}
				</button>
			</div>
		</div>
	</div>

	<!-- Entries Table -->
	<div class="section-header">
		<h2 class="section-title">{$LL.admin_access_trace_decisions()}</h2>
		<span class="entry-count">{$LL.admin_access_trace_entries({ count: total })}</span>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_access_trace_loading()}</p>
		</div>
	{:else if entries.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">
					{$LL.admin_access_trace_empty()}
				</p>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_access_trace_time()}</th>
						<th>{$LL.admin_access_trace_subject()}</th>
						<th>{$LL.admin_access_trace_permission()}</th>
						<th>{$LL.admin_access_trace_decision()}</th>
						<th>{$LL.admin_access_trace_resolved_via()}</th>
						<th class="text-right">{$LL.admin_access_trace_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each entries as entry (entry.id)}
						<tr class:denied={!entry.allowed}>
							<td class="muted nowrap">{formatTimestamp(entry.checked_at)}</td>
							<td class="mono">{entry.subject_id}</td>
							<td class="mono">{formatPermission(entry.permission, entry.permission_parsed)}</td>
							<td>
								<span class={entry.allowed ? 'badge badge-success' : 'badge badge-danger'}>
									{formatDecision(entry.allowed)}
								</span>
							</td>
							<td class="muted">{formatResolvedViaLocalized(entry.resolved_via)}</td>
							<td class="text-right">
								<button class="btn btn-secondary btn-sm" onclick={() => viewDetail(entry)}>
									{$LL.admin_access_trace_detail()}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="pagination">
				<button
					class="btn btn-secondary btn-sm"
					disabled={currentPage <= 1}
					onclick={() => (currentPage = currentPage - 1)}
				>
					{$LL.admin_access_trace_previous()}
				</button>
				<span class="pagination-info">
					{$LL.admin_access_trace_page_of({ page: currentPage, totalPages })}
				</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={currentPage >= totalPages}
					onclick={() => (currentPage = currentPage + 1)}
				>
					{$LL.admin_access_trace_next()}
				</button>
			</div>
		{/if}
	{/if}

	<!-- Top Denied Section -->
	{#if stats && stats.top_denied_permissions.length > 0}
		<div class="panel">
			<h3 class="panel-title">{$LL.admin_access_trace_top_denied_permissions()}</h3>
			<ul class="top-list">
				{#each stats.top_denied_permissions.slice(0, 5) as item (item.permission)}
					<li class="top-list-item">
						<code class="mono">{item.permission}</code>
						<span class="top-count">{item.count}</span>
					</li>
				{/each}
			</ul>

			{#if stats.top_denied_subjects.length > 0}
				<h3 class="panel-title">{$LL.admin_access_trace_top_denied_subjects()}</h3>
				<ul class="top-list">
					{#each stats.top_denied_subjects.slice(0, 5) as item (item.subject_id)}
						<li class="top-list-item">
							<code class="mono">{item.subject_id}</code>
							<span class="top-count">{item.count}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<!-- Detail Dialog -->
<Modal
	open={showDetailDialog && !!selectedEntry}
	onClose={closeDetail}
	title={$LL.admin_access_trace_detail_title()}
	size="lg"
>
	{#if selectedEntry}
		<div class="detail-grid">
			<div class="detail-row">
				<span class="detail-label">{$LL.admin_access_trace_id()}</span>
				<span class="detail-value mono">{selectedEntry.id}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$LL.admin_access_trace_time()}</span>
				<span class="detail-value">{formatTimestamp(selectedEntry.checked_at)}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$LL.admin_access_trace_subject_id()}</span>
				<span class="detail-value mono">{selectedEntry.subject_id}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$LL.admin_access_trace_permission()}</span>
				<span class="detail-value mono"
					>{formatPermission(selectedEntry.permission, selectedEntry.permission_parsed)}</span
				>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$LL.admin_access_trace_decision()}</span>
				<span class="detail-value">
					<span class={selectedEntry.allowed ? 'badge badge-success' : 'badge badge-danger'}>
						{formatDecision(selectedEntry.allowed)}
					</span>
				</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$LL.admin_access_trace_final_decision()}</span>
				<span class="detail-value">{selectedEntry.final_decision}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$LL.admin_access_trace_resolved_via()}</span>
				<span class="detail-value">{formatResolvedViaLocalized(selectedEntry.resolved_via)}</span>
			</div>
			{#if selectedEntry.reason}
				<div class="detail-row">
					<span class="detail-label">{$LL.admin_access_trace_reason()}</span>
					<span class="detail-value danger-text">{selectedEntry.reason}</span>
				</div>
			{/if}
			{#if selectedEntry.api_key_id}
				<div class="detail-row">
					<span class="detail-label">{$LL.admin_access_trace_api_key_id()}</span>
					<span class="detail-value mono">{selectedEntry.api_key_id}</span>
				</div>
			{/if}
			{#if selectedEntry.client_id}
				<div class="detail-row">
					<span class="detail-label">{$LL.admin_access_trace_client_id()}</span>
					<span class="detail-value mono">{selectedEntry.client_id}</span>
				</div>
			{/if}
		</div>

		{#if selectedEntry.permission_parsed}
			<div class="detail-section">
				<h4 class="detail-section-title">{$LL.admin_access_trace_parsed_permission()}</h4>
				<pre class="code-block">{JSON.stringify(selectedEntry.permission_parsed, null, 2)}</pre>
			</div>
		{/if}
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDetail}>
			{$LL.admin_access_trace_close()}
		</button>
	{/snippet}
</Modal>
