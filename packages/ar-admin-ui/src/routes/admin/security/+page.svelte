<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSecurityAPI,
		type AlertType,
		type SecurityAlert,
		type SuspiciousActivityType,
		type SuspiciousActivity,
		type SecurityThreat,
		type ThreatType,
		type ThreatStatus,
		type IPReputationResult,
		type AlertStatus,
		type AlertSeverity
	} from '$lib/api/admin-security';
	import { formatDate, DEFAULT_PAGE_SIZE, sanitizeText } from '$lib/utils';
	import { LL } from '$i18n/i18n-svelte';

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
	const TAB_DEFINITIONS: ReadonlyArray<{
		id: TabId;
		getLabel: () => string;
		getCount: () => number;
	}> = [
		{
			id: 'alerts',
			getLabel: () => $LL.admin_security_tab_alerts(),
			getCount: () => openAlertsCount
		},
		{
			id: 'activities',
			getLabel: () => $LL.admin_security_tab_activities(),
			getCount: () => suspiciousActivities.length
		},
		{
			id: 'threats',
			getLabel: () => $LL.admin_security_tab_threats(),
			getCount: () => detectedThreatsCount
		},
		{ id: 'ip-check', getLabel: () => $LL.admin_security_tab_ip_check(), getCount: () => 0 }
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

	function formatSeverity(severity: AlertSeverity): string {
		switch (severity) {
			case 'critical':
				return $LL.admin_security_severity_critical();
			case 'high':
				return $LL.admin_security_severity_high();
			case 'medium':
				return $LL.admin_security_severity_medium();
			case 'low':
				return $LL.admin_security_severity_low();
			case 'info':
				return $LL.admin_security_severity_info();
		}
	}

	function formatAlertStatus(status: AlertStatus): string {
		switch (status) {
			case 'open':
				return $LL.admin_security_status_open();
			case 'acknowledged':
				return $LL.admin_security_status_acknowledged();
			case 'resolved':
				return $LL.admin_security_status_resolved();
			case 'dismissed':
				return $LL.admin_security_status_dismissed();
		}
	}

	function formatThreatStatus(status: ThreatStatus): string {
		switch (status) {
			case 'detected':
				return $LL.admin_security_status_detected();
			case 'investigating':
				return $LL.admin_security_status_investigating();
			case 'mitigated':
				return $LL.admin_security_status_mitigated();
			case 'false_positive':
				return $LL.admin_security_status_false_positive();
		}
	}

	function formatRiskLevel(level: IPReputationResult['risk_level'] | 'none'): string {
		switch (level) {
			case 'critical':
				return $LL.admin_security_risk_critical();
			case 'high':
				return $LL.admin_security_risk_high();
			case 'medium':
				return $LL.admin_security_risk_medium();
			case 'low':
				return $LL.admin_security_risk_low();
			case 'none':
				return $LL.admin_security_risk_none();
		}
	}

	function formatAlertType(type: AlertType): string {
		switch (type) {
			case 'brute_force':
				return $LL.admin_security_alert_type_brute_force();
			case 'credential_stuffing':
				return $LL.admin_security_alert_type_credential_stuffing();
			case 'suspicious_login':
				return $LL.admin_security_alert_type_suspicious_login();
			case 'impossible_travel':
				return $LL.admin_security_alert_type_impossible_travel();
			case 'account_takeover':
				return $LL.admin_security_alert_type_account_takeover();
			case 'mfa_bypass_attempt':
				return $LL.admin_security_alert_type_mfa_bypass_attempt();
			case 'token_abuse':
				return $LL.admin_security_alert_type_token_abuse();
			case 'rate_limit_exceeded':
				return $LL.admin_security_alert_type_rate_limit_exceeded();
			case 'config_change':
				return $LL.admin_security_alert_type_config_change();
			case 'privilege_escalation':
				return $LL.admin_security_alert_type_privilege_escalation();
			case 'data_exfiltration':
				return $LL.admin_security_alert_type_data_exfiltration();
			default:
				return $LL.admin_security_alert_type_unknown();
		}
	}

	function formatActivityType(type: SuspiciousActivityType): string {
		switch (type) {
			case 'unusual_login_time':
				return $LL.admin_security_activity_type_unusual_login_time();
			case 'new_device':
				return $LL.admin_security_activity_type_new_device();
			case 'new_location':
				return $LL.admin_security_activity_type_new_location();
			case 'failed_mfa':
				return $LL.admin_security_activity_type_failed_mfa();
			case 'password_spray':
				return $LL.admin_security_activity_type_password_spray();
			case 'session_hijacking':
				return $LL.admin_security_activity_type_session_hijacking();
			case 'unusual_api_usage':
				return $LL.admin_security_activity_type_unusual_api_usage();
			case 'excessive_permissions':
				return $LL.admin_security_activity_type_excessive_permissions();
			case 'data_access_anomaly':
				return $LL.admin_security_activity_type_data_access_anomaly();
		}
	}

	function formatThreatType(type: ThreatType): string {
		switch (type) {
			case 'malware':
				return $LL.admin_security_threat_type_malware();
			case 'phishing':
				return $LL.admin_security_threat_type_phishing();
			case 'ransomware':
				return $LL.admin_security_threat_type_ransomware();
			case 'ddos':
				return $LL.admin_security_threat_type_ddos();
			case 'sql_injection':
				return $LL.admin_security_threat_type_sql_injection();
			case 'xss':
				return $LL.admin_security_threat_type_xss();
			case 'credential_theft':
				return $LL.admin_security_threat_type_credential_theft();
			case 'insider_threat':
				return $LL.admin_security_threat_type_insider_threat();
			case 'apt':
				return $LL.admin_security_threat_type_apt();
			case 'zero_day':
				return $LL.admin_security_threat_type_zero_day();
			default:
				return $LL.admin_security_threat_type_unknown();
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
		const names = [
			$LL.admin_security_tab_alerts(),
			$LL.admin_security_tab_activities(),
			$LL.admin_security_tab_threats()
		];
		results.forEach((result, index) => {
			if (result.status === 'rejected') {
				const message =
					result.reason instanceof Error
						? result.reason.message
						: $LL.admin_security_failed_to_load_section({ section: names[index] });
				errors.push(message);
			}
		});

		if (errors.length > 0) {
			error =
				errors.length === 1
					? errors[0]
					: $LL.admin_security_multiple_errors({ errors: errors.join('; ') });
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
			error = e instanceof Error ? e.message : $LL.admin_security_acknowledge_failed();
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
			ipCheckError = $LL.admin_security_empty_ip_error();
			return;
		}

		if (!isValidIPAddress(trimmedIP)) {
			ipCheckError = $LL.admin_security_invalid_ip_error();
			return;
		}

		checkingIP = true;
		ipCheckError = '';
		ipCheckResult = null;

		try {
			ipCheckResult = await adminSecurityAPI.checkIPReputation(trimmedIP);
		} catch (e) {
			ipCheckError = e instanceof Error ? e.message : $LL.admin_security_ip_check_failed();
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
					error = e instanceof Error ? e.message : $LL.admin_security_alerts_load_failed();
				}
			})();
		}
	});
</script>

<div class="admin-page">
	<div class="page-header">
		<div class="page-header-info">
			<h1 class="page-title">{$LL.admin_security_title()}</h1>
			<p class="page-description">
				{$LL.admin_security_description()}
			</p>
		</div>
		<button class="btn btn-secondary" onclick={loadData} disabled={loading}>
			{$LL.admin_security_refresh()}
		</button>
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
				{tab.getLabel()}
				{#if tabCount > 0}
					<span
						class="tab-count"
						class:alert-count={tab.id === 'alerts'}
						aria-label={$LL.admin_security_tab_items({ count: tabCount })}
					>
						{tabCount}
					</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if loading}
		<div class="loading-state">{$LL.admin_security_loading()}</div>
	{:else if activeTab === 'alerts'}
		<!-- Alerts Tab -->
		<div>
			<!-- Filters -->
			<div class="security-filter-bar">
				<div class="filter-group">
					<label for="status-filter" class="filter-label">{$LL.admin_security_status()}</label>
					<select id="status-filter" class="filter-select" bind:value={statusFilter}>
						<option value="">{$LL.admin_security_all_status()}</option>
						<option value="open">{$LL.admin_security_status_open()}</option>
						<option value="acknowledged">{$LL.admin_security_status_acknowledged()}</option>
						<option value="resolved">{$LL.admin_security_status_resolved()}</option>
						<option value="dismissed">{$LL.admin_security_status_dismissed()}</option>
					</select>
				</div>
				<div class="filter-group">
					<label for="severity-filter" class="filter-label">{$LL.admin_security_severity()}</label>
					<select id="severity-filter" class="filter-select" bind:value={severityFilter}>
						<option value="">{$LL.admin_security_all_severities()}</option>
						<option value="critical">{$LL.admin_security_severity_critical()}</option>
						<option value="high">{$LL.admin_security_severity_high()}</option>
						<option value="medium">{$LL.admin_security_severity_medium()}</option>
						<option value="low">{$LL.admin_security_severity_low()}</option>
						<option value="info">{$LL.admin_security_severity_info()}</option>
					</select>
				</div>
			</div>

			{#if alerts.length === 0}
				<div class="empty-state">
					<p>{$LL.admin_security_no_alerts()}</p>
				</div>
			{:else}
				<div class="security-cards-grid">
					{#each alerts as alert (alert.id)}
						<div class="security-card {getSeverityBorderClass(alert.severity)}">
							<div class="security-card-header">
								<div class="security-card-badges">
									<span class={getSeverityBadgeClass(alert.severity)}>
										{formatSeverity(alert.severity)}
									</span>
									<span class={getAlertStatusBadgeClass(alert.status)}>
										{formatAlertStatus(alert.status)}
									</span>
									<span class="alert-type-label">
										{formatAlertType(alert.type)}
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
										<span>{$LL.admin_security_ip_label()} {alert.source_ip}</span>
									{/if}
									{#if alert.user_email}
										<span>{$LL.admin_security_user_label()} {alert.user_email}</span>
									{/if}
								</div>
								{#if alert.status === 'open'}
									<button
										class="btn btn-warning btn-sm"
										onclick={() => acknowledgeAlert(alert.id)}
										disabled={acknowledgingId === alert.id}
									>
										{acknowledgingId === alert.id
											? $LL.admin_security_acknowledging()
											: $LL.admin_security_acknowledge()}
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
					<p>{$LL.admin_security_no_activities()}</p>
				</div>
			{:else}
				<div class="security-cards-grid">
					{#each suspiciousActivities as activity (activity.id)}
						<div class="security-card {getSeverityBorderClass(activity.severity)}">
							<div class="security-card-header">
								<div class="security-card-badges">
									<span class={getSeverityBadgeClass(activity.severity)}>
										{formatSeverity(activity.severity)}
									</span>
									<span class="alert-type-label">
										{formatActivityType(activity.type)}
									</span>
								</div>
								<div class="risk-score-display">
									<span class="risk-score-label">{$LL.admin_security_risk_score_label()}</span>
									<span class="risk-score-value {getRiskScoreClass(activity.risk_score)}">
										{activity.risk_score}
									</span>
								</div>
							</div>
							<p class="security-card-description activity-description">{activity.description}</p>
							<div class="security-card-meta">
								{#if activity.source_ip}
									<span>{$LL.admin_security_ip_label()} {activity.source_ip}</span>
								{/if}
								{#if activity.user_email}
									<span>{$LL.admin_security_user_label()} {activity.user_email}</span>
								{/if}
								<span>{$LL.admin_security_detected_label()} {formatDate(activity.detected_at)}</span
								>
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
					<p>{$LL.admin_security_no_threats()}</p>
				</div>
			{:else}
				<div class="security-cards-grid">
					{#each threats as threat (threat.id)}
						<div class="security-card {getSeverityBorderClass(threat.severity)}">
							<div class="security-card-header">
								<div class="security-card-badges">
									<span class={getSeverityBadgeClass(threat.severity)}>
										{formatSeverity(threat.severity)}
									</span>
									<span class={getThreatStatusBadgeClass(threat.status)}>
										{formatThreatStatus(threat.status)}
									</span>
									<span class="alert-type-label">
										{formatThreatType(threat.type)}
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
									<span class="threat-indicators-label"
										>{$LL.admin_security_indicators_label()}</span
									>
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
			<h2 class="ip-check-title">{$LL.admin_security_ip_check_title()}</h2>
			<p class="ip-check-description">{$LL.admin_security_ip_check_description()}</p>

			<div class="ip-check-form">
				<input
					type="text"
					class="ip-check-input"
					bind:value={ipToCheck}
					placeholder={$LL.admin_security_ip_placeholder()}
					onkeydown={(e) => e.key === 'Enter' && checkIPReputation()}
				/>
				<button class="btn btn-primary" onclick={checkIPReputation} disabled={checkingIP}>
					{checkingIP ? $LL.admin_security_checking() : $LL.admin_security_check()}
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
								<div class="ip-result-label">{$LL.admin_security_ip_address()}</div>
								<div class="ip-result-ip">{ipCheckResult.ip}</div>
							</div>
							<div class="ip-result-risk">
								<div class="ip-result-label">{$LL.admin_security_risk_level()}</div>
								<div class={getRiskLevelClass(ipCheckResult.risk_level)}>
									{formatRiskLevel(ipCheckResult.risk_level)}
								</div>
							</div>
						</div>
					</div>
					<div class="ip-result-body">
						<div class="ip-result-stats">
							<div class="ip-stat">
								<div class="ip-stat-label">{$LL.admin_security_risk_score()}</div>
								<div class="ip-stat-value">{ipCheckResult.risk_score}/100</div>
							</div>
							<div class="ip-stat">
								<div class="ip-stat-label">{$LL.admin_security_failed_auth_24h()}</div>
								<div class="ip-stat-value">{ipCheckResult.failed_auth_attempts_24h}</div>
							</div>
							<div class="ip-stat">
								<div class="ip-stat-label">{$LL.admin_security_rate_limit_violations()}</div>
								<div class="ip-stat-value">{ipCheckResult.rate_limit_violations_24h}</div>
							</div>
						</div>

						<div class="ip-blocked-status {ipCheckResult.is_blocked ? 'blocked' : 'not-blocked'}">
							{ipCheckResult.is_blocked
								? `⛔ ${$LL.admin_security_ip_blocked()}`
								: `✓ ${$LL.admin_security_ip_not_blocked()}`}
						</div>

						{#if ipCheckResult.recommendations.length > 0}
							<div class="ip-recommendations">
								<div class="ip-recommendations-title">{$LL.admin_security_recommendations()}</div>
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
