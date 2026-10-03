/**
 * An in-memory Compliance API for Storybook and tests: a tenant's status, one open access review,
 * reports and data retention, answering as the Admin API does (decisions are recorded, completing
 * needs every item decided, a shortened lookup retention asks for confirmation).
 */
import { ApiError } from '../api-error';
import type {
	AccessReview,
	ComplianceClient,
	ComplianceReport,
	ComplianceStatus,
	ReviewItem,
	RetentionStatus
} from '../compliance';

export interface FakeComplianceOptions {
	/** Status: every check compliant, or some needing attention (default). */
	status?: 'attention' | 'compliant';
	/** The status cannot be read (the API answers 503). */
	statusUnavailable?: boolean;
	/** No access reviews or reports yet. */
	empty?: boolean;
	/** Milliseconds every call waits (to show loading states). */
	delay?: number;
	now?: number;
}

const DAY = 86_400_000;

function fakeStatus(compliant: boolean, now: number): ComplianceStatus {
	const warning = compliant ? 'compliant' : 'warning';
	return {
		tenant_id: 'acme',
		overall_status: warning,
		frameworks: (
			[
				['gdpr', 2, 2],
				['soc2', 6, 6],
				['iso27001', 6, 6],
				['pci_dss', 3, 3]
			] as const
		).map(([framework, total, checks]) => ({
			framework,
			status: compliant || framework === 'pci_dss' ? 'compliant' : 'warning',
			compliant_checks: compliant || framework === 'pci_dss' ? checks : checks - 1,
			warning_checks: compliant || framework === 'pci_dss' ? 0 : 1,
			non_compliant_checks: 0,
			not_applicable_checks: 0,
			total_checks: total
		})),
		checks: [
			{
				id: 'data_retention_enforced',
				frameworks: ['gdpr', 'soc2', 'iso27001'],
				status: warning,
				facts: {
					attention: compliant ? [] : ['lookup_directory:not_deleted'],
					expired_records: 0
				}
			},
			{
				id: 'audit_logging',
				frameworks: ['soc2', 'iso27001', 'pci_dss'],
				status: 'compliant',
				facts: { hot_query_status: 'supported', entries_last_30_days: 3120 }
			},
			{
				id: 'admin_mfa',
				frameworks: ['soc2', 'iso27001', 'pci_dss'],
				status: 'compliant',
				facts: { admins: 3, with_passkey: 3 }
			},
			{
				id: 'user_mfa_enforced',
				frameworks: ['soc2', 'iso27001'],
				status: compliant ? 'compliant' : 'warning',
				facts: {
					assurance_enabled: compliant,
					default_aal: compliant ? 'AAL2' : null,
					scopes_requiring_mfa: []
				}
			},
			{
				id: 'user_mfa_coverage',
				frameworks: ['soc2', 'iso27001'],
				status: 'compliant',
				facts: { users: 1240, with_mfa: 1082, percent: 87 }
			},
			{
				id: 'rbac_configured',
				frameworks: ['gdpr', 'soc2', 'iso27001', 'pci_dss'],
				status: 'compliant',
				facts: { active_roles: 6, users_with_roles: 48 }
			}
		],
		data_retention: {
			expired_records: 0,
			attention: compliant ? [] : [{ category: 'lookup_directory', reason: 'not_deleted' }]
		},
		audit_log: {
			enabled: true,
			event_retention_days: 90,
			pii_retention_days: 365,
			total_entries: 48_200,
			entries_last_30_days: 3120,
			hot_query_status: 'supported'
		},
		mfa: {
			enforcement: {
				enforced: compliant,
				assurance_enabled: compliant,
				default_aal: compliant ? 'AAL2' : null,
				scopes_requiring_mfa: []
			},
			admins: { admins: 3, with_passkey: 3 },
			users: {
				users: 1240,
				with_passkey: 902,
				with_totp: 310,
				with_any: 1082,
				guests: 37,
				deleting: 1
			}
		},
		access_control: { active_roles: 6, users_with_roles: 48 },
		accounts: { pending_deletions: 1 },
		generated_at: new Date(now).toISOString()
	};
}

function fakeItems(now: number): ReviewItem[] {
	const people = [
		['u-akira', 'Akira Tanaka', 'akira@acme.example'],
		['u-maria', 'Maria Garcia', 'maria@acme.example'],
		['u-chen', 'Chen Wei', 'chen@acme.example'],
		['u-fatima', 'Fatima Al-Sayed', 'fatima@acme.example'],
		['u-lukas', 'Lukas Becker', 'lukas@acme.example']
	] as const;
	return people.map(([id, name, email], index) => ({
		item_id: `item-${index + 1}`,
		user_id: id,
		user: { name, email },
		permission_type: 'role',
		permission_value: 'tenant_admin',
		decision: index === 0 ? 'approved' : index === 1 ? 'revoked' : null,
		decided_by: index < 2 ? 'admin-1' : null,
		decided_at: index < 2 ? new Date(now - DAY).toISOString() : null,
		justification: index === 1 ? 'Moved to finance' : null,
		apply_status: null,
		applied_at: null,
		apply_error: null
	}));
}

export function createFakeCompliance(options: FakeComplianceOptions = {}): ComplianceClient {
	const now = options.now ?? Date.parse('2026-10-03T09:00:00Z');
	const items = fakeItems(now);
	let reviewStatus: AccessReview['status'] = 'in_progress';
	let lookupDays = 180;
	const reviews = (): AccessReview[] => {
		const decided = items.filter((item) => item.decision !== null);
		return [
			{
				review_id: 'review-q4',
				name: 'Q4 tenant admin review',
				description: 'Quarterly review of who administers the tenant',
				scope: 'role',
				scope_value: 'tenant_admin',
				inactive_days: null,
				status: reviewStatus,
				reviewer_id: 'admin-1',
				created_by: 'admin-1',
				completed_by: reviewStatus === 'completed' ? 'admin-1' : null,
				progress: {
					total_items: items.length,
					reviewed_items: decided.length,
					approved_items: decided.filter((item) => item.decision === 'approved').length,
					revoked_items: decided.filter((item) => item.decision === 'revoked').length,
					completion_percent: Math.round((decided.length / items.length) * 100)
				},
				created_at: new Date(now - 2 * DAY).toISOString(),
				started_at: new Date(now - 2 * DAY).toISOString(),
				completed_at: reviewStatus === 'completed' ? new Date(now).toISOString() : null,
				due_date: new Date(now + 12 * DAY).toISOString(),
				overdue: false
			}
		];
	};
	const reports: ComplianceReport[] = options.empty
		? []
		: [
				{
					report_id: 'report-1',
					type: 'mfa_coverage',
					name: 'MFA coverage — September',
					status: 'completed',
					requested_by: 'admin-1',
					parameters: null,
					format: 'csv',
					row_count: 1243,
					size_bytes: 52_000,
					sha256: 'a'.repeat(64),
					error: null,
					created_at: new Date(now - 3 * DAY).toISOString(),
					completed_at: new Date(now - 3 * DAY).toISOString(),
					expires_at: new Date(now + 27 * DAY).toISOString(),
					downloadable: true
				},
				{
					report_id: 'report-0',
					type: 'audit_log',
					name: 'Audit log — Q2',
					status: 'failed',
					requested_by: 'admin-1',
					parameters: { from: '2026-04-01T00:00:00Z', to: '2026-07-01T00:00:00Z' },
					format: null,
					row_count: null,
					size_bytes: null,
					sha256: null,
					error: 'too_large',
					created_at: new Date(now - 5 * DAY).toISOString(),
					completed_at: new Date(now - 5 * DAY).toISOString(),
					expires_at: null,
					downloadable: false
				}
			];
	const wait = () =>
		options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay)) : undefined;
	const page = <T>(data: T[]) => ({ data, pagination: { has_more: false } });

	const retention = (): RetentionStatus => ({
		tenant_id: 'acme',
		categories: [
			{
				id: 'audit_events',
				retention: { value: 90, unit: 'days' },
				source: { kind: 'audit', from: 'audit_profile' },
				edit: { kind: 'audit_profile' },
				deletion: {
					kind: 'scheduled_task',
					task: 'audit_retention',
					enabled: true,
					disabled_reason: null,
					status: 'succeeded',
					last_started_at: now - 3_600_000,
					last_completed_at: now - 3_500_000,
					last_error_code: null,
					next_run_at: now + 18_000_000,
					tenant_last_run: { at: now - 3_500_000, outcome: 'cleaned' }
				},
				varies: null,
				counts: { total: 48_200, expired: 0 },
				archive: { deletion: 'not_deleted' }
			},
			{
				id: 'lookup_directory',
				retention: { value: lookupDays, unit: 'days' },
				source: { kind: 'lookup_policy' },
				edit: { kind: 'lookup_directory' },
				deletion: {
					kind: 'not_deleted',
					reason: 'lookup_purge_not_available',
					projection: 'current'
				},
				varies: null,
				counts: null
			},
			{
				id: 'sessions',
				retention: { value: 604_800, unit: 'seconds' },
				source: { kind: 'session_settings' },
				edit: { kind: 'session_settings' },
				deletion: { kind: 'expiry' },
				varies: 'by_sign_in_method',
				counts: null,
				extension: { per_refresh_seconds: 86_400, absolute_limit_seconds: null }
			},
			{
				id: 'access_tokens',
				retention: { value: 3600, unit: 'seconds' },
				source: { kind: 'setting', category: 'oauth', key: 'oauth.access_token_expiry' },
				edit: { kind: 'settings', category: 'oauth', key: 'oauth.access_token_expiry' },
				deletion: { kind: 'not_stored' },
				varies: 'by_app',
				counts: null
			}
		],
		summary: {
			expired_records: 0,
			attention: [
				{ category: 'audit_events', reason: 'archive_not_deleted' },
				{ category: 'lookup_directory', reason: 'not_deleted' },
				{ category: 'sessions', reason: 'no_absolute_limit' }
			]
		},
		generated_at: new Date(now).toISOString()
	});

	return {
		async status() {
			await wait();
			if (options.statusUnavailable) {
				throw new ApiError(503, 'temporarily_unavailable', 'The compliance status cannot be read');
			}
			return fakeStatus(options.status === 'compliant', now);
		},
		async reviews() {
			await wait();
			return page(options.empty ? [] : reviews());
		},
		async review() {
			await wait();
			return { ...reviews()[0]!, application: { applied: 0, failed: 0, pending_revocations: 1 } };
		},
		async reviewItems(_tenantId, _id, { decision }) {
			await wait();
			return page(
				items.filter((item) =>
					decision === 'pending'
						? item.decision === null
						: decision
							? item.decision === decision
							: true
				)
			);
		},
		async createReview(_tenantId, review) {
			await wait();
			return { ...reviews()[0]!, ...review, review_id: 'review-new', name: review.name };
		},
		async decide(_tenantId, _id, change) {
			await wait();
			for (const item of items) {
				if (change.item_ids.includes(item.item_id)) {
					item.decision = change.decision;
					item.decided_by = 'admin-1';
					item.decided_at = new Date(now).toISOString();
					item.justification = change.justification ?? null;
				}
			}
			return { updated: change.item_ids.length, unchanged: 0, review: reviews()[0]! };
		},
		async complete() {
			await wait();
			const undecided = items.filter((item) => item.decision === null).length;
			if (undecided > 0) {
				throw new ApiError(409, 'conflict', 'Every item must be decided', {
					error: 'access_review_undecided_items',
					undecided_items: undecided
				});
			}
			reviewStatus = 'completed';
			const revoked = items.filter((item) => item.decision === 'revoked').length;
			return { completed: true, applied: revoked, failed: 0, remaining: 0, review: reviews()[0]! };
		},
		async cancel() {
			await wait();
			reviewStatus = 'cancelled';
			return reviews()[0]!;
		},
		async reports() {
			await wait();
			return page([...reports]);
		},
		async createReport(_tenantId, report) {
			await wait();
			const created: ComplianceReport = {
				...reports[0]!,
				report_id: `report-${reports.length + 1}`,
				type: report.type,
				name: report.name ?? report.type,
				parameters: report.parameters ?? null,
				status: 'completed',
				error: null,
				downloadable: true,
				created_at: new Date(now).toISOString()
			};
			reports.unshift(created);
			return created;
		},
		async download(_tenantId, id) {
			await wait();
			return {
				blob: new Blob(['kind,id\nadmin,admin-1\n'], { type: 'text/csv' }),
				filename: `compliance-${id}.csv`
			};
		},
		async retention() {
			await wait();
			return retention();
		},
		async setLookupRetention(_tenantId, change) {
			await wait();
			if (change.retention_days < lookupDays && !change.confirm_shortening) {
				throw new ApiError(409, 'conflict', 'Confirm shortening', {
					error: 'retention_shortening_confirmation_required',
					current_retention_days: lookupDays,
					requested_retention_days: change.retention_days
				});
			}
			lookupDays = change.retention_days;
		}
	};
}
