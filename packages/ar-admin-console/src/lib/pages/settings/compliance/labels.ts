/**
 * Words and tones the compliance views share. A value the API adds later falls back to its raw
 * text (never HTML).
 */
import type {
	ApplyStatus,
	CheckStatus,
	ComplianceCheck,
	Framework,
	ReportStatus,
	RetentionCategory,
	ReviewStatus
} from '$lib/api/compliance';
import { hasMessage, i18n, t } from '$lib/i18n/i18n.svelte';
import { formatNumber } from '$lib/ui/format';
import { formatTime } from '$lib/ui/time/format-time';
import { timePreference } from '$lib/ui/time/time-preference.svelte';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** The message for `key`, or the raw value when there is none. */
export function label(prefix: string, value: string): string {
	const key = `${prefix}${value}`;
	return hasMessage(key) ? t(key) : value;
}

export function statusTone(status: CheckStatus): Tone {
	return status === 'compliant'
		? 'success'
		: status === 'warning'
			? 'warning'
			: status === 'non_compliant'
				? 'danger'
				: 'neutral';
}

export const statusLabel = (status: CheckStatus) => label('cmp.status.', status);

export function frameworkLabel(framework: Framework): string {
	const names: Record<Framework, string> = {
		gdpr: 'GDPR',
		soc2: 'SOC 2',
		iso27001: 'ISO 27001',
		pci_dss: 'PCI DSS'
	};
	return names[framework] ?? framework;
}

export function reviewTone(status: ReviewStatus): Tone {
	return status === 'completed'
		? 'success'
		: status === 'in_progress'
			? 'info'
			: status === 'cancelled'
				? 'neutral'
				: 'warning';
}

export function applyTone(status: ApplyStatus | null): Tone {
	return status === 'applied'
		? 'success'
		: status === 'incomplete' || status === 'failed'
			? 'danger'
			: status === 'applying'
				? 'info'
				: 'neutral';
}

export function reportTone(status: ReportStatus): Tone {
	return status === 'completed'
		? 'success'
		: status === 'failed'
			? 'danger'
			: status === 'generating'
				? 'info'
				: 'neutral';
}

const count = (value: unknown) => (typeof value === 'number' ? value : 0);

/** A check's facts in words. */
export function checkFacts(check: ComplianceCheck): string {
	const facts = check.facts;
	switch (check.id) {
		case 'data_retention_enforced': {
			// Reasons are `category:reason`; a category may have several.
			const categories = Array.isArray(facts.attention)
				? new Set(facts.attention.map((entry) => String(entry).split(':')[0])).size
				: 0;
			return categories === 0
				? t('cmp.fact.retentionOk')
				: t('cmp.fact.retentionAttention', {
						count: categories,
						expired: count(facts.expired_records)
					});
		}
		case 'audit_logging':
			return facts.hot_query_status === 'supported'
				? t('cmp.fact.audit', { entries: count(facts.entries_last_30_days) })
				: t('cmp.fact.auditNotQueryable', { status: String(facts.hot_query_status) });
		case 'admin_mfa':
			return t('cmp.fact.adminMfa', {
				with: count(facts.with_passkey),
				total: count(facts.admins)
			});
		case 'user_mfa_enforced':
			return check.status === 'compliant'
				? t('cmp.fact.mfaEnforced', {
						aal: facts.default_aal ? String(facts.default_aal) : '—',
						scopes: Array.isArray(facts.scopes_requiring_mfa)
							? facts.scopes_requiring_mfa.length
							: 0
					})
				: t('cmp.fact.mfaNotEnforced');
		case 'user_mfa_coverage':
			return t('cmp.fact.userMfa', {
				with: count(facts.with_mfa),
				total: count(facts.users),
				percent: count(facts.percent)
			});
		case 'rbac_configured':
			return t('cmp.fact.rbac', {
				roles: count(facts.active_roles),
				users: count(facts.users_with_roles)
			});
		default:
			return '';
	}
}

/** A length of time in the largest whole unit it is ("90 days", "1 hour"), the local way. */
export function duration(seconds: number): string {
	const [value, unit] =
		seconds % 86_400 === 0
			? [seconds / 86_400, 'day']
			: seconds % 3600 === 0
				? [seconds / 3600, 'hour']
				: seconds % 60 === 0
					? [seconds / 60, 'minute']
					: [seconds, 'second'];
	return formatNumber(value, i18n.locale, { style: 'unit', unit, unitDisplay: 'long' });
}

export function retentionText(category: RetentionCategory): string {
	return duration(
		category.retention.unit === 'days'
			? category.retention.value * 86_400
			: category.retention.value
	);
}

export function deletionText(category: RetentionCategory): string {
	const deletion = category.deletion;
	switch (deletion.kind) {
		case 'scheduled_task':
			return deletion.enabled
				? t('cmp.ret.task')
				: t('cmp.ret.taskDisabled', { reason: deletion.disabled_reason ?? '—' });
		case 'expiry':
			return t('cmp.ret.expiry');
		case 'not_stored':
			return t('cmp.ret.notStored');
		default:
			return t('cmp.ret.notDeleted');
	}
}

export function editText(category: RetentionCategory): string {
	switch (category.edit.kind) {
		case 'settings':
			return t('cmp.ret.edit.settings', { category: category.edit.category ?? '' });
		case 'session_settings':
			return t('cmp.ret.edit.session');
		case 'audit_profile':
		case 'audit_routing_rules':
			return t('cmp.ret.edit.audit');
		case 'audit_pii_config':
			return t('cmp.ret.edit.pii');
		case 'lookup_directory':
			return t('cmp.ret.edit.lookup');
		default:
			return t('cmp.ret.edit.none');
	}
}

/** A time as text in the admin's zone preference (for use inside a sentence). */
export function timeText(value: string | number | null | undefined): string {
	if (value === null || value === undefined || value === '') return '—';
	return (
		formatTime(value, { locale: i18n.locale, zone: timePreference.zone, style: 'datetime' })
			?.text ?? '—'
	);
}
