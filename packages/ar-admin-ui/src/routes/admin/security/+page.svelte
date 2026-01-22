<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSecurityAPI,
		getAlertTypeDisplayName,
		getThreatTypeDisplayName,
		type SecurityAlert,
		type SuspiciousActivity,
		type SecurityThreat,
		type IPReputationResult,
		type AlertStatus,
		type AlertSeverity
	} from '$lib/api/admin-security';
	import { formatDate, DEFAULT_PAGE_SIZE, sanitizeText } from '$lib/utils';

	// State
	let loading = $state(true);
	let error = $state('');
	let alerts = $state<SecurityAlert[]>([]);
	let suspiciousActivities = $state<SuspiciousActivity[]>([]);
	let threats = $state<SecurityThreat[]>([]);

	// Tabs
	let activeTab = $state<'alerts' | 'activities' | 'threats' | 'ip-check'>('alerts');

	// Filters
	let statusFilter = $state<AlertStatus | ''>('');
	let severityFilter = $state<AlertSeverity | ''>('');

	// IP Check
	let ipToCheck = $state('');
	let checkingIP = $state(false);
	let ipCheckResult = $state<IPReputationResult | null>(null);
	let ipCheckError = $state('');

	// Acknowledging
	let acknowledgingId = $state<string | null>(null);

	// Request counter to handle race conditions
	let alertsRequestId = 0;

	// Tab definitions with type safety
	type TabId = 'alerts' | 'activities' | 'threats' | 'ip-check';
	const TAB_DEFINITIONS: ReadonlyArray<{ id: TabId; label: string; getCount: () => number }> = [
		{ id: 'alerts', label: 'Alerts', getCount: () => openAlertsCount },
		{
			id: 'activities',
			label: 'Suspicious Activities',
			getCount: () => suspiciousActivities.length
		},
		{ id: 'threats', label: 'Threats', getCount: () => detectedThreatsCount },
		{ id: 'ip-check', label: 'IP Check', getCount: () => 0 }
	];

	// Helper functions for CSS classes
	function getSeverityBadgeClass(severity: string): string {
		switch (severity) {
			case 'critical':
				return 'badge-severity critical';
			case 'high':
				return 'badge-severity high';
			case 'medium':
				return 'badge-severity medium';
			case 'low':
				return 'badge-severity low';
			case 'info':
				return 'badge-severity info';
			default:
				return 'badge-severity';
		}
	}

	function getAlertStatusBadgeClass(status: string): string {
		switch (status) {
			case 'open':
				return 'badge-alert-status open';
			case 'acknowledged':
				return 'badge-alert-status acknowledged';
			case 'resolved':
				return 'badge-alert-status resolved';
			case 'dismissed':
				return 'badge-alert-status dismissed';
			default:
				return 'badge-alert-status';
		}
	}

	function getThreatStatusBadgeClass(status: string): string {
		switch (status) {
			case 'detected':
				return 'badge-threat-status detected';
			case 'investigating':
				return 'badge-threat-status investigating';
			case 'mitigated':
				return 'badge-threat-status mitigated';
			default:
				return 'badge-threat-status';
		}
	}

	function getSeverityBorderClass(severity: string): string {
		switch (severity) {
			case 'critical':
				return 'severity-border-critical';
			case 'high':
				return 'severity-border-high';
			case 'medium':
				return 'severity-border-medium';
			case 'low':
				return 'severity-border-low';
			case 'info':
				return 'severity-border-info';
			default:
				return '';
		}
	}

	function getRiskScoreClass(score: number): string {
		if (score >= 80) return 'risk-score-high';
		if (score >= 50) return 'risk-score-medium';
		return 'risk-score-low';
	}

	function getRiskLevelClass(level: string): string {
		switch (level) {
			case 'critical':
			case 'high':
				return 'ip-risk-level high';
			case 'medium':
				return 'ip-risk-level medium';
			case 'low':
			case 'none':
				return 'ip-risk-level low';
			default:
				return 'ip-risk-level';
		}
	}

	function getRiskLevelBgClass(level: string): string {
		switch (level) {
			case 'critical':
			case 'high':
				return 'ip-result-header risk-high';
			case 'medium':
				return 'ip-result-header risk-medium';
			case 'low':
			case 'none':
				return 'ip-result-header risk-low';
			default:
				return 'ip-result-header';
		}
	}

	// Sanitize API responses to prevent XSS (defense in depth)
	function sanitizeAlert(alert: SecurityAlert): SecurityAlert {
		return {
			...alert,
			title: sanitizeText(alert.title),
			description: sanitizeText(alert.description),
			user_email: alert.user_email ? sanitizeText(alert.user_email) : undefined
		};
	}

	function sanitizeActivity(activity: SuspiciousActivity): SuspiciousActivity {
		return {
			...activity,
			description: sanitizeText(activity.description),
			user_email: activity.user_email ? sanitizeText(activity.user_email) : undefined
		};
	}

	function sanitizeThreat(threat: SecurityThreat): SecurityThreat {
		return {
			...threat,
			title: sanitizeText(threat.title),
			description: sanitizeText(threat.description),
			indicators: Array.isArray(threat.indicators)
				? threat.indicators.map((i) => sanitizeText(i))
				: []
		};
	}

	async function loadAlerts(): Promise<void> {
		const requestId = ++alertsRequestId;
		const params: { status?: AlertStatus; severity?: AlertSeverity } = {};
		if (statusFilter) params.status = statusFilter;
		if (severityFilter) params.severity = severityFilter;

		const response = await adminSecurityAPI.listAlerts({ ...params, limit: DEFAULT_PAGE_SIZE });

		// Only update if this is still the latest request
		if (requestId === alertsRequestId) {
			// Defensive check: ensure response.data is an array
			// Apply sanitization to prevent XSS
			alerts = Array.isArray(response.data) ? response.data.map(sanitizeAlert) : [];
		}
	}

	async function loadSuspiciousActivities(): Promise<void> {
		const response = await adminSecurityAPI.listSuspiciousActivities({ limit: DEFAULT_PAGE_SIZE });
		// Defensive check: ensure response.data is an array
		// Apply sanitization to prevent XSS
		suspiciousActivities = Array.isArray(response.data) ? response.data.map(sanitizeActivity) : [];
	}

	async function loadThreats(): Promise<void> {
		const response = await adminSecurityAPI.listThreats({ limit: DEFAULT_PAGE_SIZE });
		// Defensive check: ensure response.data is an array
		// Apply sanitization to prevent XSS
		threats = Array.isArray(response.data) ? response.data.map(sanitizeThreat) : [];
	}

	async function loadData() {
		loading = true;
		error = '';

		const results = await Promise.allSettled([
			loadAlerts(),
			loadSuspiciousActivities(),
			loadThreats()
		]);

		// Collect all errors
		const errors: string[] = [];
		const names = ['Alerts', 'Suspicious Activities', 'Threats'];
		results.forEach((result, index) => {
			if (result.status === 'rejected') {
				const message =
					result.reason instanceof Error ? result.reason.message : `Failed to load ${names[index]}`;
				errors.push(message);
			}
		});

		if (errors.length > 0) {
			error = errors.length === 1 ? errors[0] : `Multiple errors: ${errors.join('; ')}`;
		}

		loading = false;
	}

	onMount(() => {
		loadData();
	});

	async function acknowledgeAlert(alertId: string) {
		acknowledgingId = alertId;
		error = ''; // Clear previous errors
		try {
			const updated = await adminSecurityAPI.acknowledgeAlert(alertId);
			// Apply sanitization to prevent XSS
			alerts = alerts.map((a) => (a.id === alertId ? sanitizeAlert(updated) : a));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to acknowledge alert';
		} finally {
			acknowledgingId = null;
		}
	}

	/**
	 * Validate IP address format (IPv4 or IPv6)
	 */
	function isValidIPAddress(ip: string): boolean {
		// IPv4: 0-255.0-255.0-255.0-255
		const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
		const ipv4Match = ip.match(ipv4Regex);
		if (ipv4Match) {
			return ipv4Match.slice(1).every((octet) => {
				const num = parseInt(octet, 10);
				return num >= 0 && num <= 255;
			});
		}

		// IPv6: simplified check for valid hex groups separated by colons
		// Supports full form and :: abbreviation
		const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
		return ipv6Regex.test(ip);
	}

	async function checkIPReputation() {
		const trimmedIP = ipToCheck.trim();

		if (!trimmedIP) {
			ipCheckError = 'Please enter an IP address';
			return;
		}

		if (!isValidIPAddress(trimmedIP)) {
			ipCheckError = 'Invalid IP address format. Please enter a valid IPv4 or IPv6 address.';
			return;
		}

		checkingIP = true;
		ipCheckError = '';
		ipCheckResult = null;

		try {
			ipCheckResult = await adminSecurityAPI.checkIPReputation(trimmedIP);
		} catch (e) {
			ipCheckError = e instanceof Error ? e.message : 'Failed to check IP reputation';
		} finally {
			checkingIP = false;
		}
	}

	// Track if initial data load has completed
	let initialLoadComplete = false;
	// Track previous filter values to detect actual changes
	let prevStatusFilter = '';
	let prevSeverityFilter = '';

	// Memoized tab counts to avoid recalculation on every render
	let openAlertsCount = $derived(alerts.filter((a) => a.status === 'open').length);
	let detectedThreatsCount = $derived(threats.filter((t) => t.status === 'detected').length);

	// Reactive filter effect - reload alerts when filters change
	$effect(() => {
		const currentStatus = statusFilter;
		const currentSeverity = severityFilter;
		const currentTab = activeTab;
		const isLoading = loading;

		// Skip effect during initial mount (onMount handles first load)
		if (!initialLoadComplete) {
			if (!isLoading) {
				initialLoadComplete = true;
				prevStatusFilter = currentStatus;
				prevSeverityFilter = currentSeverity;
			}
			return;
		}

		// Only reload if filters actually changed
		const filtersChanged =
			currentStatus !== prevStatusFilter || currentSeverity !== prevSeverityFilter;

		if (currentTab === 'alerts' && !isLoading && filtersChanged) {
			prevStatusFilter = currentStatus;
			prevSeverityFilter = currentSeverity;
			// Wrap in async IIFE to handle errors
			(async () => {
				try {
					await loadAlerts();
				} catch (e) {
					error = e instanceof Error ? e.message : 'Failed to load alerts';
				}
			})();
		}
	});
</script>

<div class="admin-page">
	<div class="page-header">
		<div class="page-header-info">
			<h1 class="page-title">Security</h1>
			<p class="modal-description">
				Monitor security alerts, suspicious activities, detected threats, and check IP reputation.
			</p>
		</div>
		<button class="btn btn-secondary" onclick={loadData} disabled={loading}> Refresh </button>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<!-- Tabs -->
	<div class="security-tabs" role="tablist">
		{#each TAB_DEFINITIONS as tab (tab.id)}
			{@const tabCount = tab.getCount()}
			<button
				onclick={() => {
					error = '';
					activeTab = tab.id;
				}}
				role="tab"
				aria-selected={activeTab === tab.id}
				aria-controls="{tab.id}-panel"
				class="security-tab"
				class:active={activeTab === tab.id}
			>
				{tab.label}
				{#if tabCount > 0}
					<span
						class="tab-count"
						class:alert-count={tab.id === 'alerts'}
						aria-label="{tabCount} items"
					>
						{tabCount}
					</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if loading}
		<div class="loading-state">Loading security data...</div>
	{:else if activeTab === 'alerts'}
		<!-- Alerts Tab -->
		<div>
			<!-- Filters -->
			<div class="security-filter-bar">
				<div class="filter-group">
					<label for="status-filter" class="filter-label">Status</label>
					<select id="status-filter" class="filter-select" bind:value={statusFilter}>
						<option value="">All Status</option>
						<option value="open">Open</option>
						<option value="acknowledged">Acknowledged</option>
						<option value="resolved">Resolved</option>
						<option value="dismissed">Dismissed</option>
					</select>
				</div>
				<div class="filter-group">
					<label for="severity-filter" class="filter-label">Severity</label>
					<select id="severity-filter" class="filter-select" bind:value={severityFilter}>
						<option value="">All Severities</option>
						<option value="critical">Critical</option>
						<option value="high">High</option>
						<option value="medium">Medium</option>
						<option value="low">Low</option>
						<option value="info">Info</option>
					</select>
				</div>
			</div>

			{#if alerts.length === 0}
				<div class="empty-state">
					<p>No security alerts found.</p>
				</div>
			{:else}
				<div class="security-cards-grid">
					{#each alerts as alert (alert.id)}
						<div class="security-card {getSeverityBorderClass(alert.severity)}">
							<div class="security-card-header">
								<div class="security-card-badges">
									<span class={getSeverityBadgeClass(alert.severity)}>
										{alert.severity.toUpperCase()}
									</span>
									<span class={getAlertStatusBadgeClass(alert.status)}>
										{alert.status}
									</span>
									<span class="alert-type-label">
										{getAlertTypeDisplayName(alert.type)}
									</span>
								</div>
								<span class="security-card-date">
									{formatDate(alert.created_at)}
								</span>
							</div>
							<h3 class="security-card-title">{alert.title}</h3>
							<p class="security-card-description">{alert.description}</p>
							<div class="security-card-footer">
								<div class="security-card-meta">
									{#if alert.source_ip}
										<span>IP: {alert.source_ip}</span>
									{/if}
									{#if alert.user_email}
										<span>User: {alert.user_email}</span>
									{/if}
								</div>
								{#if alert.status === 'open'}
									<button
										class="btn btn-warning btn-sm"
										onclick={() => acknowledgeAlert(alert.id)}
										disabled={acknowledgingId === alert.id}
									>
										{acknowledgingId === alert.id ? 'Acknowledging...' : 'Acknowledge'}
									</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{:else if activeTab === 'activities'}
		<!-- Suspicious Activities Tab -->
		<div>
			{#if suspiciousActivities.length === 0}
				<div class="empty-state">
					<p>No suspicious activities detected.</p>
				</div>
			{:else}
				<div class="security-cards-grid">
					{#each suspiciousActivities as activity (activity.id)}
						<div class="security-card {getSeverityBorderClass(activity.severity)}">
							<div class="security-card-header">
								<div class="security-card-badges">
									<span class={getSeverityBadgeClass(activity.severity)}>
										{activity.severity.toUpperCase()}
									</span>
									<span class="alert-type-label">
										{activity.type.replace(/_/g, ' ')}
									</span>
								</div>
								<div class="risk-score-display">
									<span class="risk-score-label">Risk Score:</span>
									<span class="risk-score-value {getRiskScoreClass(activity.risk_score)}">
										{activity.risk_score}
									</span>
								</div>
							</div>
							<p class="security-card-description activity-description">{activity.description}</p>
							<div class="security-card-meta">
								{#if activity.source_ip}
									<span>IP: {activity.source_ip}</span>
								{/if}
								{#if activity.user_email}
									<span>User: {activity.user_email}</span>
								{/if}
								<span>Detected: {formatDate(activity.detected_at)}</span>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{:else if activeTab === 'threats'}
		<!-- Threats Tab -->
		<div>
			{#if threats.length === 0}
				<div class="empty-state">
					<p>No threats detected.</p>
				</div>
			{:else}
				<div class="security-cards-grid">
					{#each threats as threat (threat.id)}
						<div class="security-card {getSeverityBorderClass(threat.severity)}">
							<div class="security-card-header">
								<div class="security-card-badges">
									<span class={getSeverityBadgeClass(threat.severity)}>
										{threat.severity.toUpperCase()}
									</span>
									<span class={getThreatStatusBadgeClass(threat.status)}>
										{threat.status}
									</span>
									<span class="alert-type-label">
										{getThreatTypeDisplayName(threat.type)}
									</span>
								</div>
								<span class="security-card-date">
									{formatDate(threat.detected_at)}
								</span>
							</div>
							<h3 class="security-card-title">{threat.title}</h3>
							<p class="security-card-description">{threat.description}</p>
							{#if Array.isArray(threat.indicators) && threat.indicators.length > 0}
								<div class="threat-indicators">
									<span class="threat-indicators-label">Indicators:</span>
									<div class="threat-indicators-list">
										{#each threat.indicators as indicator (indicator)}
											<span class="threat-indicator-tag">{indicator}</span>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{:else if activeTab === 'ip-check'}
		<!-- IP Check Tab -->
		<div class="ip-check-section">
			<h2 class="ip-check-title">IP Reputation Check</h2>
			<p class="ip-check-description">Check the reputation and risk level of an IP address.</p>

			<div class="ip-check-form">
				<input
					type="text"
					class="ip-check-input"
					bind:value={ipToCheck}
					placeholder="Enter IP address (e.g., 192.168.1.1)"
					onkeydown={(e) => e.key === 'Enter' && checkIPReputation()}
				/>
				<button class="btn btn-primary" onclick={checkIPReputation} disabled={checkingIP}>
					{checkingIP ? 'Checking...' : 'Check'}
				</button>
			</div>

			{#if ipCheckError}
				<div class="alert alert-error">{ipCheckError}</div>
			{/if}

			{#if ipCheckResult}
				<div class="ip-result-card">
					<div class={getRiskLevelBgClass(ipCheckResult.risk_level)}>
						<div class="ip-result-header-content">
							<div>
								<div class="ip-result-label">IP Address</div>
								<div class="ip-result-ip">{ipCheckResult.ip}</div>
							</div>
							<div class="ip-result-risk">
								<div class="ip-result-label">Risk Level</div>
								<div class={getRiskLevelClass(ipCheckResult.risk_level)}>
									{ipCheckResult.risk_level.toUpperCase()}
								</div>
							</div>
						</div>
					</div>
					<div class="ip-result-body">
						<div class="ip-result-stats">
							<div class="ip-stat">
								<div class="ip-stat-label">Risk Score</div>
								<div class="ip-stat-value">{ipCheckResult.risk_score}/100</div>
							</div>
							<div class="ip-stat">
								<div class="ip-stat-label">Failed Auth (24h)</div>
								<div class="ip-stat-value">{ipCheckResult.failed_auth_attempts_24h}</div>
							</div>
							<div class="ip-stat">
								<div class="ip-stat-label">Rate Limit Violations</div>
								<div class="ip-stat-value">{ipCheckResult.rate_limit_violations_24h}</div>
							</div>
						</div>

						<div class="ip-blocked-status {ipCheckResult.is_blocked ? 'blocked' : 'not-blocked'}">
							{ipCheckResult.is_blocked ? '⛔ This IP is BLOCKED' : '✓ This IP is NOT blocked'}
						</div>

						{#if ipCheckResult.recommendations.length > 0}
							<div class="ip-recommendations">
								<div class="ip-recommendations-title">Recommendations</div>
								<ul class="ip-recommendations-list">
									{#each ipCheckResult.recommendations as rec (rec)}
										<li>{rec}</li>
									{/each}
								</ul>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
