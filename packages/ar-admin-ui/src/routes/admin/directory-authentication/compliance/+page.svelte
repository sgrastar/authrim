<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminDirectoryAuthAPI,
		type DirectoryAuthConfigHistory,
		type DirectoryAuthEvidenceExport,
		type DirectoryAuthManagedConnectorEpisode,
		type DirectoryAuthManagedConnectorInstance,
		type DirectoryAuthReleaseAdvisory,
		type DirectoryAuthRetentionPolicy,
		type DirectoryAuthSummaryLink,
		type DirectoryAuthSupportBundle
	} from '$lib/api/admin-directory-auth';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import DirectoryAuthenticationTabs from '../DirectoryAuthenticationTabs.svelte';

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let evidenceError = $state('');
	let successMessage = $state('');
	let tenantId = $state('');
	let retentionPolicy = $state<DirectoryAuthRetentionPolicy | null>(null);
	let evidenceExports = $state<DirectoryAuthEvidenceExport[]>([]);
	let supportBundles = $state<DirectoryAuthSupportBundle[]>([]);
	let configHistory = $state<DirectoryAuthConfigHistory[]>([]);
	let summaryLinks = $state<DirectoryAuthSummaryLink[]>([]);
	let advisories = $state<DirectoryAuthReleaseAdvisory[]>([]);
	let managedConnectors = $state<DirectoryAuthManagedConnectorInstance[]>([]);
	let managedConnectorEpisodes = $state<DirectoryAuthManagedConnectorEpisode[]>([]);
	let authrimRetentionDays = $state(365);
	let wordwardenRetentionDays = $state(14);
	let artifactDeleteGraceHours = $state(72);
	let exportStart = $state('');
	let exportEnd = $state('');
	let downloadAfterDelete = $state(false);
	let supportRedactionLevel = $state<'minimal' | 'standard' | 'detailed'>('standard');
	let detailedWarningAcknowledged = $state(false);
	let cleanupReason = $state('manual_cleanup');

	const currentTenantId = $derived(settingsContext.tenantId);
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());

	function formatTime(value: number | null | undefined): string {
		if (!value) return '-';
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
	}

	function parseDateInput(value: string): number | null {
		if (!value) return null;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function affectedAdvisories(version: string): DirectoryAuthReleaseAdvisory[] {
		const normalized = normalizeVersion(version);
		return advisories.filter((advisory) =>
			parseAffectedVersions(advisory.affected_versions_json).some((candidate) =>
				versionMatches(candidate, normalized)
			)
		);
	}

	function affectedAdvisoryCount(connector: DirectoryAuthManagedConnectorInstance): number {
		return connector.affected_advisory_count ?? affectedAdvisories(connector.version).length;
	}

	function parseAffectedVersions(raw: string): string[] {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return Array.isArray(parsed)
				? parsed.filter((value): value is string => typeof value === 'string')
				: [];
		} catch {
			return [];
		}
	}

	function versionMatches(candidate: string, normalizedVersion: string): boolean {
		const normalizedCandidate = normalizeVersion(candidate);
		if (!normalizedCandidate) return false;
		if (normalizedCandidate === '*') return true;
		if (normalizedCandidate === normalizedVersion) return true;
		for (const operator of ['<=', '>=', '<', '>'] as const) {
			if (normalizedCandidate.startsWith(operator)) {
				const expected = normalizeVersion(normalizedCandidate.slice(operator.length));
				const compared = compareVersions(normalizedVersion, expected);
				if (operator === '<=') return compared <= 0;
				if (operator === '>=') return compared >= 0;
				if (operator === '<') return compared < 0;
				return compared > 0;
			}
		}
		return (
			normalizedCandidate.endsWith('.*') &&
			normalizedVersion.startsWith(normalizedCandidate.slice(0, -1))
		);
	}

	function normalizeVersion(value: string): string {
		return value.trim().replace(/^v/i, '');
	}

	function compareVersions(left: string, right: string): number {
		const leftParts = versionParts(left);
		const rightParts = versionParts(right);
		const max = Math.max(leftParts.length, rightParts.length);
		for (let index = 0; index < max; index += 1) {
			const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	}

	function versionParts(value: string): number[] {
		return value
			.split('-')[0]
			.split('.')
			.map((part) => Number.parseInt(part, 10))
			.map((part) => (Number.isFinite(part) ? part : 0));
	}

	function applyRetention(policy: DirectoryAuthRetentionPolicy | null) {
		retentionPolicy = policy;
		authrimRetentionDays = policy?.authrim_audit_retention_days ?? 365;
		wordwardenRetentionDays = policy?.wordwarden_local_retention_days ?? 14;
		artifactDeleteGraceHours = policy?.artifact_delete_grace_hours ?? 72;
	}

	async function loadCompliance(selectedTenantId: string) {
		loading = true;
		error = '';
		evidenceError = '';
		successMessage = '';
		tenantId = selectedTenantId;
		try {
			const [retention, bundlesResponse, historyResponse, advisoryResponse, connectorsResponse] =
				await Promise.all([
					adminDirectoryAuthAPI.getRetention(selectedTenantId),
					adminDirectoryAuthAPI.listSupportBundles(selectedTenantId),
					adminDirectoryAuthAPI.listConfigHistory(selectedTenantId),
					adminDirectoryAuthAPI.listAdvisories(selectedTenantId),
					adminDirectoryAuthAPI.listManagedConnectors(selectedTenantId)
				]);
			applyRetention(retention.policy);
			supportBundles = bundlesResponse.items;
			configHistory = historyResponse.items;
			summaryLinks = historyResponse.public_summary_links;
			advisories = advisoryResponse.items;
			managedConnectors = connectorsResponse.items;
			managedConnectorEpisodes = connectorsResponse.recent_episodes;
			try {
				const exportsResponse = await adminDirectoryAuthAPI.listEvidenceExports(selectedTenantId);
				evidenceExports = exportsResponse.items;
			} catch (err) {
				evidenceExports = [];
				evidenceError =
					err instanceof Error
						? err.message
						: $LL.admin_directory_authentication_compliance_evidence_unavailable();
			}
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_compliance_load_failed();
			applyRetention(null);
			evidenceExports = [];
			supportBundles = [];
			configHistory = [];
			summaryLinks = [];
			advisories = [];
			managedConnectors = [];
			managedConnectorEpisodes = [];
		} finally {
			loading = false;
		}
	}

	async function saveRetention() {
		if (!tenantId || !canEdit) return;
		saving = true;
		error = '';
		successMessage = '';
		try {
			const response = await adminDirectoryAuthAPI.updateRetention(tenantId, {
				authrim_audit_retention_days: Number(authrimRetentionDays),
				wordwarden_local_retention_days: Number(wordwardenRetentionDays),
				artifact_delete_grace_hours: Number(artifactDeleteGraceHours)
			});
			applyRetention(response.policy);
			successMessage = $LL.admin_directory_authentication_compliance_retention_saved();
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_compliance_retention_save_failed();
		} finally {
			saving = false;
		}
	}

	async function createEvidenceExport() {
		if (!tenantId || !canEdit) return;
		const periodStartAt = parseDateInput(exportStart);
		const periodEndAt = parseDateInput(exportEnd);
		if (!periodStartAt || !periodEndAt || periodEndAt <= periodStartAt) {
			error = $LL.admin_directory_authentication_compliance_invalid_export_period();
			return;
		}
		saving = true;
		error = '';
		successMessage = '';
		try {
			await adminDirectoryAuthAPI.createEvidenceExport(tenantId, {
				period_start_at: periodStartAt,
				period_end_at: periodEndAt,
				download_after_delete: downloadAfterDelete
			});
			successMessage = $LL.admin_directory_authentication_compliance_export_created();
			const response = await adminDirectoryAuthAPI.listEvidenceExports(tenantId);
			evidenceExports = response.items;
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_compliance_export_create_failed();
		} finally {
			saving = false;
		}
	}

	async function createSupportBundle() {
		if (!tenantId || !canEdit) return;
		saving = true;
		error = '';
		successMessage = '';
		try {
			await adminDirectoryAuthAPI.createSupportBundle(tenantId, {
				redaction_level: supportRedactionLevel,
				consent_summary: {
					operator_confirmed: true,
					detailed_warning_acknowledged: detailedWarningAcknowledged
				}
			});
			successMessage = $LL.admin_directory_authentication_compliance_support_created();
			const response = await adminDirectoryAuthAPI.listSupportBundles(tenantId);
			supportBundles = response.items;
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_compliance_support_create_failed();
		} finally {
			saving = false;
		}
	}

	async function runCleanup() {
		if (!tenantId || !canEdit) return;
		saving = true;
		error = '';
		successMessage = '';
		try {
			const response = await adminDirectoryAuthAPI.runMaintenanceCleanup(
				tenantId,
				cleanupReason.trim() || 'manual_cleanup'
			);
			successMessage = $LL.admin_directory_authentication_compliance_cleanup_completed({
				transactions: response.result.migration_transactions_expired,
				exports: response.result.evidence_exports_expired,
				bundles: response.result.support_bundles_expired
			});
			await loadCompliance(tenantId);
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_compliance_cleanup_failed();
		} finally {
			saving = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
		const selectedTenantId = settingsContext.tenantId;
		if (!selectedTenantId) {
			loading = false;
			error = $LL.admin_directory_authentication_compliance_select_tenant();
			return;
		}
		await loadCompliance(selectedTenantId);
	});

	$effect(() => {
		if (!currentTenantId || loading || currentTenantId === tenantId) return;
		void loadCompliance(currentTenantId);
	});

	$effect(() => {
		if (supportRedactionLevel !== 'detailed') {
			detailedWarningAcknowledged = false;
		}
	});
</script>

<svelte:head>
	<title>{$LL.admin_directory_authentication_compliance_page_title()}</title>
</svelte:head>

{#snippet headerActions()}
	<button
		class="btn btn-primary"
		disabled={loading || !tenantId}
		onclick={() => loadCompliance(tenantId)}
	>
		{$LL.admin_directory_authentication_pending_refresh()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_directory_authentication_compliance_title()}
		description={$LL.admin_directory_authentication_compliance_description()}
		actions={headerActions}
	/>

	<DirectoryAuthenticationTabs active="compliance" />

	{#if error}
		<div class="alert alert--error">{error}</div>
	{/if}
	{#if successMessage}
		<div class="alert alert--success">{successMessage}</div>
	{/if}

	<AdminSection
		title={$LL.admin_directory_authentication_compliance_retention_title()}
		description={$LL.admin_directory_authentication_compliance_retention_description()}
	>
		<div class="retention-grid">
			<label>
				<span>{$LL.admin_directory_authentication_compliance_authrim_retention()}</span>
				<input type="number" min="30" max="2555" bind:value={authrimRetentionDays} />
			</label>
			<label>
				<span>{$LL.admin_directory_authentication_compliance_wordwarden_retention()}</span>
				<input type="number" min="1" max="30" bind:value={wordwardenRetentionDays} />
			</label>
			<label>
				<span>{$LL.admin_directory_authentication_compliance_artifact_grace()}</span>
				<input type="number" min="24" max="168" bind:value={artifactDeleteGraceHours} />
			</label>
			<button class="btn btn-primary" disabled={!canEdit || saving} onclick={saveRetention}>
				{$LL.admin_directory_authentication_compliance_save_retention()}
			</button>
		</div>
		{#if retentionPolicy}
			<p class="meta-line">
				{$LL.admin_directory_authentication_updated()}
				{formatTime(retentionPolicy.updated_at)}
				{$LL.admin_directory_authentication_migration_by()}
				{retentionPolicy.updated_by ?? '-'}
			</p>
		{/if}
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_compliance_maintenance_title()}
		description={$LL.admin_directory_authentication_compliance_maintenance_description()}
	>
		<div class="maintenance-row">
			<label>
				<span>{$LL.admin_directory_authentication_compliance_reason()}</span>
				<input bind:value={cleanupReason} disabled={!canEdit || saving} />
			</label>
			<button class="btn btn-secondary" disabled={!canEdit || saving} onclick={runCleanup}>
				{$LL.admin_directory_authentication_compliance_run_cleanup()}
			</button>
		</div>
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_compliance_evidence_title()}
		description={$LL.admin_directory_authentication_compliance_evidence_description()}
	>
		{#if evidenceError}
			<div class="alert alert--error">{evidenceError}</div>
		{/if}
		<div class="export-grid">
			<label>
				<span>{$LL.admin_directory_authentication_compliance_period_start()}</span>
				<input type="datetime-local" bind:value={exportStart} />
			</label>
			<label>
				<span>{$LL.admin_directory_authentication_compliance_period_end()}</span>
				<input type="datetime-local" bind:value={exportEnd} />
			</label>
			<label class="checkbox-row">
				<input type="checkbox" bind:checked={downloadAfterDelete} />
				<span>{$LL.admin_directory_authentication_compliance_delete_after_download()}</span>
			</label>
			<button class="btn btn-primary" disabled={!canEdit || saving} onclick={createEvidenceExport}>
				{$LL.admin_directory_authentication_compliance_create_export()}
			</button>
		</div>
		{@render evidenceExportTable(evidenceExports)}
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_compliance_support_title()}
		description={$LL.admin_directory_authentication_compliance_support_description()}
	>
		<div class="support-row">
			<label>
				<span>{$LL.admin_directory_authentication_compliance_redaction_level()}</span>
				<select bind:value={supportRedactionLevel}>
					<option value="minimal"
						>{$LL.admin_directory_authentication_compliance_redaction_minimal()}</option
					>
					<option value="standard"
						>{$LL.admin_directory_authentication_compliance_redaction_standard()}</option
					>
					<option value="detailed"
						>{$LL.admin_directory_authentication_compliance_redaction_detailed()}</option
					>
				</select>
			</label>
			<button
				class="btn btn-primary"
				disabled={!canEdit ||
					saving ||
					(supportRedactionLevel === 'detailed' && !detailedWarningAcknowledged)}
				onclick={createSupportBundle}
			>
				{$LL.admin_directory_authentication_compliance_create_support_bundle()}
			</button>
		</div>
		{#if supportRedactionLevel === 'detailed'}
			<p class="warning-line">{$LL.admin_directory_authentication_compliance_detailed_warning()}</p>
			<label class="checkbox-row warning-ack">
				<input type="checkbox" bind:checked={detailedWarningAcknowledged} />
				<span>{$LL.admin_directory_authentication_compliance_ack_warning()}</span>
			</label>
		{/if}
		{@render jobTable(supportBundles)}
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_compliance_config_history_title()}
		description={$LL.admin_directory_authentication_compliance_config_history_description()}
	>
		{#if configHistory.length === 0}
			<div class="empty-state">
				{$LL.admin_directory_authentication_compliance_no_config_history()}
			</div>
		{:else}
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_directory_authentication_compliance_time()}</th>
						<th>{$LL.admin_directory_authentication_compliance_action()}</th>
						<th>{$LL.admin_directory_authentication_compliance_resource()}</th>
						<th>{$LL.admin_directory_authentication_compliance_actor()}</th>
						<th>{$LL.admin_directory_authentication_compliance_after()}</th>
					</tr>
				</thead>
				<tbody>
					{#each configHistory as entry (entry.id)}
						<tr>
							<td>{formatTime(entry.created_at)}</td>
							<td>{entry.action}</td>
							<td>{entry.resource_type}<br /><code>{entry.resource_id ?? '-'}</code></td>
							<td>{entry.actor_id ?? '-'}</td>
							<td><code>{JSON.stringify(entry.after_redacted)}</code></td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		{/if}
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_compliance_summary_links_title()}
		description={$LL.admin_directory_authentication_compliance_summary_links_description()}
	>
		{#if summaryLinks.length === 0}
			<div class="empty-state">
				{$LL.admin_directory_authentication_compliance_no_summary_links()}
			</div>
		{:else}
			<div class="link-list">
				{#each summaryLinks as link (link.href)}
					<a class="btn btn-secondary" href={link.href}>{link.label}</a>
				{/each}
			</div>
		{/if}
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_compliance_managed_connectors_title()}
		description={$LL.admin_directory_authentication_compliance_managed_connectors_description()}
	>
		{#if loading}
			<p class="state-text">{$LL.admin_directory_authentication_loading_short()}</p>
		{:else if managedConnectors.length === 0}
			<div class="empty-state">{$LL.admin_directory_authentication_compliance_no_heartbeat()}</div>
		{:else}
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_directory_authentication_compliance_connector()}</th>
						<th>{$LL.admin_directory_authentication_compliance_instance()}</th>
						<th>{$LL.admin_directory_authentication_compliance_version()}</th>
						<th>{$LL.admin_directory_authentication_compliance_channel()}</th>
						<th>{$LL.admin_directory_authentication_compliance_advisory()}</th>
						<th>{$LL.admin_directory_authentication_compliance_status()}</th>
						<th>{$LL.admin_directory_authentication_compliance_health()}</th>
						<th>{$LL.admin_directory_authentication_compliance_last_seen()}</th>
					</tr>
				</thead>
				<tbody>
					{#each managedConnectors as connector (connector.instance_id)}
						<tr>
							<td><code>{connector.connector_id}</code></td>
							<td><code>{connector.instance_id}</code></td>
							<td>{connector.version}</td>
							<td>{connector.release_channel}</td>
							<td>
								{#if affectedAdvisoryCount(connector) > 0}
									{affectedAdvisoryCount(connector)}
									{$LL.admin_directory_authentication_compliance_affected()}
								{:else}
									-
								{/if}
							</td>
							<td>{connector.status}</td>
							<td>{connector.health_status}</td>
							<td>{formatTime(connector.last_seen_at)}</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		{/if}
		{#if managedConnectorEpisodes.length > 0}
			<AdminDataTable compact>
				<thead>
					<tr>
						<th>{$LL.admin_directory_authentication_compliance_recent_episode()}</th>
						<th>{$LL.admin_directory_authentication_compliance_status()}</th>
						<th>{$LL.admin_directory_authentication_compliance_started()}</th>
						<th>{$LL.admin_directory_authentication_compliance_reason()}</th>
					</tr>
				</thead>
				<tbody>
					{#each managedConnectorEpisodes as episode (episode.id)}
						<tr>
							<td><code>{episode.instance_id}</code></td>
							<td>{episode.status}</td>
							<td>{formatTime(episode.started_at)}</td>
							<td>{episode.reason ?? '-'}</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		{/if}
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_compliance_advisories_title()}
		description={$LL.admin_directory_authentication_compliance_advisories_description()}
	>
		{#if loading}
			<p class="state-text">{$LL.admin_directory_authentication_loading_short()}</p>
		{:else if advisories.length === 0}
			<div class="empty-state">{$LL.admin_directory_authentication_compliance_no_advisories()}</div>
		{:else}
			<div class="advisory-list">
				{#each advisories as advisory (advisory.id)}
					<section class="advisory-row">
						<div>
							<strong>{advisory.summary}</strong>
							<p>
								{advisory.channel} · {advisory.severity} ·
								{$LL.admin_directory_authentication_compliance_fixed()}
								{advisory.fixed_version ?? '-'}
							</p>
						</div>
						<span>{formatTime(advisory.updated_at)}</span>
					</section>
				{/each}
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

{#snippet evidenceExportTable(jobs: DirectoryAuthEvidenceExport[])}
	{#if loading}
		<p class="state-text">{$LL.admin_directory_authentication_loading_short()}</p>
	{:else if jobs.length === 0}
		<div class="empty-state">{$LL.admin_directory_authentication_compliance_no_jobs()}</div>
	{:else}
		<AdminDataTable width="wide">
			<thead>
				<tr>
					<th>{$LL.admin_directory_authentication_compliance_id()}</th>
					<th>{$LL.admin_directory_authentication_compliance_status()}</th>
					<th>{$LL.admin_directory_authentication_compliance_requested_by()}</th>
					<th>{$LL.admin_directory_authentication_compliance_retention_expires()}</th>
					<th>{$LL.admin_directory_authentication_compliance_checksum()}</th>
					<th>{$LL.admin_directory_authentication_compliance_artifact()}</th>
				</tr>
			</thead>
			<tbody>
				{#each jobs as job (job.id)}
					<tr>
						<td><code>{job.id}</code></td>
						<td>{job.status}</td>
						<td>{job.requested_by}</td>
						<td>{formatTime(job.retention_expires_at)}</td>
						<td><code>{job.artifact_sha256?.slice(0, 16) ?? '-'}</code></td>
						<td>
							{#if job.artifact_download_url}
								<a class="btn btn-secondary btn-small" href={job.artifact_download_url}>
									{$LL.admin_directory_authentication_compliance_download()}
								</a>
							{:else}
								<span class="state-text">{job.artifact_key ?? '-'}</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</AdminDataTable>
	{/if}
{/snippet}

{#snippet jobTable(jobs: Array<DirectoryAuthEvidenceExport | DirectoryAuthSupportBundle>)}
	{#if loading}
		<p class="state-text">{$LL.admin_directory_authentication_loading_short()}</p>
	{:else if jobs.length === 0}
		<div class="empty-state">{$LL.admin_directory_authentication_compliance_no_jobs()}</div>
	{:else}
		<AdminDataTable width="wide">
			<thead>
				<tr>
					<th>{$LL.admin_directory_authentication_compliance_id()}</th>
					<th>{$LL.admin_directory_authentication_compliance_status()}</th>
					<th>{$LL.admin_directory_authentication_compliance_requested_by()}</th>
					<th>{$LL.admin_directory_authentication_compliance_retention_expires()}</th>
					<th>{$LL.admin_directory_authentication_compliance_artifact()}</th>
				</tr>
			</thead>
			<tbody>
				{#each jobs as job (job.id)}
					<tr>
						<td><code>{job.id}</code></td>
						<td>{job.status}</td>
						<td>{job.requested_by}</td>
						<td>{formatTime(job.retention_expires_at)}</td>
						<td>
							{#if 'artifact_download_url' in job && job.artifact_download_url}
								<a class="btn btn-secondary btn-small" href={job.artifact_download_url}>
									{$LL.admin_directory_authentication_compliance_download()}
								</a>
							{:else}
								<span class="state-text">{job.artifact_key ?? '-'}</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</AdminDataTable>
	{/if}
{/snippet}

<style>
	.retention-grid,
	.export-grid,
	.maintenance-row,
	.support-row {
		display: grid;
		grid-template-columns: repeat(3, minmax(180px, 1fr)) auto;
		gap: 0.75rem;
		align-items: end;
	}

	.maintenance-row {
		grid-template-columns: minmax(220px, 1fr) auto;
	}

	.support-row {
		grid-template-columns: minmax(220px, 320px) auto;
		justify-content: start;
	}

	.link-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.875rem;
	}

	input,
	select {
		min-height: 2.5rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
		color: var(--color-text);
		padding: 0 0.75rem;
	}

	.checkbox-row {
		grid-template-columns: auto 1fr;
		align-items: center;
	}

	.checkbox-row input {
		min-height: auto;
	}

	.meta-line,
	.warning-line {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		margin: 0.75rem 0 0;
	}

	.warning-line {
		color: var(--color-warning);
	}

	th,
	td {
		border-bottom: 1px solid var(--color-border);
		padding: 0.75rem;
		text-align: left;
		vertical-align: top;
	}

	.advisory-list {
		display: grid;
		gap: 0.75rem;
	}

	.advisory-row {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		border-bottom: 1px solid var(--color-border);
		padding: 0.75rem 0;
	}

	.advisory-row p {
		margin: 0.25rem 0 0;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
	}

	@media (max-width: 840px) {
		.retention-grid,
		.export-grid,
		.maintenance-row,
		.support-row {
			grid-template-columns: 1fr;
		}
	}
</style>
