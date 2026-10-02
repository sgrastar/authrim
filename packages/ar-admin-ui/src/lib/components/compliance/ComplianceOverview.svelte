<script lang="ts">
	import type { ComplianceCheck, ComplianceStatus } from '$lib/api/admin-compliance';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import {
		checkLabel,
		formatDateTime,
		frameworkLabel,
		statusBadgeClass,
		statusLabel
	} from './format';

	interface Props {
		status: ComplianceStatus;
	}

	let { status }: Props = $props();

	const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

	/** A check's facts in words. */
	function describe(check: ComplianceCheck): string {
		const facts = check.facts;
		switch (check.id) {
			case 'data_retention_enforced': {
				// Reasons are `category:reason`; a category may have several.
				const attention = Array.isArray(facts.attention)
					? new Set(facts.attention.map((entry) => String(entry).split(':')[0])).size
					: 0;
				return attention === 0
					? $LL.admin_compliance_fact_retention_ok()
					: $LL.admin_compliance_fact_attention({
							count: attention,
							expired: number(facts.expired_records)
						});
			}
			case 'audit_logging':
				return facts.hot_query_status === 'supported'
					? $LL.admin_compliance_fact_audit({
							entries: number(facts.entries_last_30_days),
							status: String(facts.hot_query_status)
						})
					: $LL.admin_compliance_fact_audit_not_queryable({
							status: String(facts.hot_query_status)
						});
			case 'admin_mfa':
				return $LL.admin_compliance_fact_admin_mfa({
					with: number(facts.with_passkey),
					total: number(facts.admins)
				});
			case 'user_mfa_enforced':
				return check.status === 'compliant'
					? $LL.admin_compliance_fact_mfa_enforced({
							aal: facts.default_aal ? String(facts.default_aal) : '—',
							scopes: Array.isArray(facts.scopes_requiring_mfa)
								? facts.scopes_requiring_mfa.length
								: 0
						})
					: $LL.admin_compliance_fact_mfa_not_enforced();
			case 'user_mfa_coverage':
				return $LL.admin_compliance_fact_user_mfa({
					with: number(facts.with_mfa),
					total: number(facts.users),
					percent: number(facts.percent)
				});
			case 'rbac_configured':
				return $LL.admin_compliance_fact_rbac({
					roles: number(facts.active_roles),
					users: number(facts.users_with_roles)
				});
			default:
				return '';
		}
	}

	const userPercent = $derived(
		status.mfa.users.users > 0
			? Math.round((status.mfa.users.with_any / status.mfa.users.users) * 100)
			: 0
	);
</script>

<div class="compliance-overview">
	<AdminSection
		title={$LL.admin_compliance_overall_status()}
		description={$LL.admin_compliance_overall_hint()}
	>
		<div class="overall-row">
			<span class={statusBadgeClass(status.overall_status)}>
				{statusLabel($LL, status.overall_status)}
			</span>
			<span class="text-secondary">
				{$LL.admin_compliance_generated_at({ at: formatDateTime(status.generated_at) })}
			</span>
		</div>
	</AdminSection>

	<AdminSection
		title={$LL.admin_compliance_frameworks()}
		description={$LL.admin_compliance_frameworks_hint()}
	>
		<div class="framework-grid">
			{#each status.frameworks as framework (framework.framework)}
				<div class="framework-card">
					<div class="framework-card-header">
						<h3 class="framework-name">{frameworkLabel(framework.framework)}</h3>
						<span class={statusBadgeClass(framework.status)}>
							{statusLabel($LL, framework.status)}
						</span>
					</div>
					<p class="text-secondary framework-counts">
						{$LL.admin_compliance_framework_counts({
							compliant: framework.compliant_checks,
							warning: framework.warning_checks,
							non_compliant: framework.non_compliant_checks
						})}
					</p>
				</div>
			{/each}
		</div>
	</AdminSection>

	<AdminSection title={$LL.admin_compliance_checks()}>
		<AdminDataTable width="wide">
			<thead>
				<tr>
					<th>{$LL.admin_compliance_check()}</th>
					<th>{$LL.admin_compliance_facts()}</th>
					<th>{$LL.admin_compliance_frameworks()}</th>
				</tr>
			</thead>
			<tbody>
				{#each status.checks as check (check.id)}
					<tr>
						<td>
							<div class="cell-primary">{checkLabel($LL, check.id)}</div>
							<span class={statusBadgeClass(check.status)}>{statusLabel($LL, check.status)}</span>
						</td>
						<td>{describe(check)}</td>
						<td class="text-secondary">{check.frameworks.map(frameworkLabel).join(', ')}</td>
					</tr>
				{/each}
			</tbody>
		</AdminDataTable>
	</AdminSection>

	<div class="stats-grid">
		<div class="stat-card">
			<div class="stat-label">{$LL.admin_compliance_mfa_admins()}</div>
			<div class="stat-value">
				{status.mfa.admins.with_passkey} / {status.mfa.admins.admins}
			</div>
		</div>
		<div class="stat-card">
			<div class="stat-label">{$LL.admin_compliance_mfa_users()}</div>
			<div class="stat-value">{userPercent}%</div>
			<div class="stat-note">
				{status.mfa.users.with_any} / {status.mfa.users.users} · {$LL.admin_compliance_mfa_passkey()}
				{status.mfa.users.with_passkey} · {$LL.admin_compliance_mfa_totp()}
				{status.mfa.users.with_totp}
			</div>
		</div>
		<div class="stat-card">
			<div class="stat-label">{$LL.admin_compliance_mfa_enforcement()}</div>
			<div class="stat-value">
				{status.mfa.enforcement.enforced
					? $LL.admin_compliance_mfa_enforced_yes()
					: $LL.admin_compliance_mfa_enforced_no()}
			</div>
			{#if status.mfa.users.guests > 0}
				<div class="stat-note">
					{$LL.admin_compliance_mfa_guests()}: {status.mfa.users.guests}
				</div>
			{/if}
		</div>
		<div class="stat-card">
			<div class="stat-label">{$LL.admin_compliance_audit_event_retention()}</div>
			<div class="stat-value">
				{status.audit_log.event_retention_days === null
					? '—'
					: $LL.admin_compliance_days({ count: status.audit_log.event_retention_days })}
			</div>
			<div class="stat-note">
				{$LL.admin_compliance_audit_pii_retention()}:
				{status.audit_log.pii_retention_days === null
					? '—'
					: $LL.admin_compliance_days({ count: status.audit_log.pii_retention_days })}
			</div>
		</div>
		<div class="stat-card">
			<div class="stat-label">{$LL.admin_compliance_access_control()}</div>
			<div class="stat-value">{status.access_control.users_with_roles}</div>
			<div class="stat-note">
				{$LL.admin_compliance_fact_rbac({
					roles: status.access_control.active_roles,
					users: status.access_control.users_with_roles
				})}
			</div>
		</div>
		<div class="stat-card">
			<div class="stat-label">{$LL.admin_compliance_pending_deletions()}</div>
			<div class="stat-value">{status.accounts.pending_deletions}</div>
		</div>
	</div>
</div>

<style>
	.compliance-overview {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.overall-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.framework-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 16px;
	}

	.framework-card {
		border: 1px solid var(--border, #e5e7eb);
		border-radius: var(--radius-md, 8px);
		padding: 16px;
		background: var(--bg-card, transparent);
	}

	.framework-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.framework-name {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
	}

	.framework-counts {
		margin: 8px 0 0;
		font-size: 0.875rem;
	}
</style>
