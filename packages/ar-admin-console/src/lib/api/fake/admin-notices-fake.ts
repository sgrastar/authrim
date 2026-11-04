/**
 * In-memory admin notices API for Storybook and tests. Follows the Admin API's rules: only
 * information is dismissed (per admin), the rest is resolved once, a platform announcement needs
 * platform authority, and an announcement is checked before it is kept.
 */
import { ApiError, ConflictError } from '../api-error';
import {
	BODY_MAX,
	TITLE_MAX,
	isConsolePath,
	type AdminNotice,
	type AdminNoticesClient,
	type PublishNoticeInput
} from '../admin-notices';

export interface FakeAdminNoticesOptions {
	/** The notices that exist; defaults to `sampleNotices()`. */
	notices?: AdminNotice[];
	/** Milliseconds each call takes. */
	delay?: number;
	/** Fail every call with this status. */
	fail?: 403 | 404 | 500;
	/** Fail only these calls (the list loads, an action fails); 409 answers the way a lost race does. */
	failOn?: Partial<Record<'get' | 'dismiss' | 'resolve' | 'publish', 403 | 409 | 500>>;
	/** The signed-in admin holds platform authority. */
	platform?: boolean;
	/** The signed-in admin may resolve and publish (`admin:settings:write`). */
	canWrite?: boolean;
}

const NOW = Date.UTC(2026, 10, 4, 3, 0, 0);
const MINUTE = 60_000;

const base = (partial: Partial<AdminNotice> & Pick<AdminNotice, 'id'>): AdminNotice => ({
	scope_type: 'tenant',
	tenant_id: 'acme',
	client_id: null,
	admin_user_id: null,
	severity: 'info',
	source: 'system',
	category: 'announcement',
	message_key: null,
	params: {},
	title: '',
	body: null,
	link: null,
	created_by: null,
	created_at: NOW,
	expires_at: null,
	resolved_at: null,
	resolved_by: null,
	dismissible: false,
	...partial
});

export function sampleNotices(): AdminNotice[] {
	return [
		base({
			id: 'ntc_recovery',
			severity: 'high',
			category: 'second_factor_recovery',
			message_key: 'second_factor_recovery_requested',
			params: { email: 'sam@example.com' },
			title: 'sam@example.com asked to recover a security key',
			link: '/admin/me',
			created_at: NOW - 5 * MINUTE
		}),
		base({
			id: 'ntc_dlq',
			severity: 'caution',
			category: 'logging_dlq_backlog',
			message_key: 'logging_dlq_backlog',
			params: {},
			title: 'The logging dead-letter queue is backing up',
			body: 'Delivery to the log destination has been failing for 40 minutes.',
			link: '/admin/integrations/notifications?id=ntc_dlq',
			created_at: NOW - 40 * MINUTE
		}),
		base({
			id: 'ntc_platform',
			scope_type: 'platform',
			tenant_id: null,
			severity: 'critical',
			category: 'control_plane_drift',
			message_key: 'control_plane_drift',
			params: { tenant_id: 'globex' },
			title: 'Control plane drift detected',
			created_at: NOW - 3 * 60 * MINUTE
		}),
		base({
			id: 'ntc_announce',
			severity: 'info',
			source: 'announcement',
			category: 'announcement',
			title: 'Maintenance on Saturday',
			body: 'Sign-in may be unavailable for about ten minutes from 02:00.',
			created_by: 'admin-2',
			created_at: NOW - 26 * 60 * MINUTE,
			dismissible: true
		})
	].map((notice) => ({ ...notice, dismissible: notice.severity === 'info' }));
}

export function createFakeAdminNotices(options: FakeAdminNoticesOptions = {}): AdminNoticesClient {
	const canWrite = options.canWrite ?? true;
	const store = (options.notices ?? sampleNotices()).map((notice) => ({ ...notice }));
	const dismissed = new Set<string>();
	let sequence = 0;

	async function step(
		call: 'list' | 'get' | 'dismiss' | 'resolve' | 'publish',
		signal?: AbortSignal
	) {
		if (options.delay) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, options.delay);
				signal?.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new DOMException('cancelled', 'AbortError'));
				});
			});
		}
		const status = options.fail ?? (call === 'list' ? undefined : options.failOn?.[call]);
		if (status === 409) {
			throw new ConflictError('Conflict', {
				error: call === 'dismiss' ? 'notice_not_dismissible' : 'notice_resolved'
			});
		}
		if (status) throw new ApiError(status, status === 403 ? 'forbidden' : 'error', `${status}`);
	}

	const find = (id: string) => {
		const notice = store.find((item) => item.id === id);
		if (!notice) throw new ApiError(404, 'not_found', 'Not found');
		return notice;
	};

	return {
		async list(signal) {
			await step('list', signal);
			return store
				.filter(
					(notice) =>
						!notice.resolved_at &&
						!dismissed.has(notice.id) &&
						(notice.scope_type !== 'platform' || (options.platform ?? false))
				)
				.map((notice) => ({ ...notice }))
				.sort((a, b) => b.created_at - a.created_at);
		},
		async get(id, signal) {
			await step('get', signal);
			return { ...find(id) };
		},
		async dismiss(id) {
			await step('dismiss');
			const notice = find(id);
			if (!notice.dismissible)
				throw new ConflictError('Not dismissible', { error: 'notice_not_dismissible' });
			dismissed.add(id);
		},
		async resolve(id) {
			await step('resolve');
			const notice = find(id);
			if (!canWrite) throw new ApiError(403, 'forbidden', 'Forbidden');
			if (notice.resolved_at) throw new ConflictError('Resolved', { error: 'notice_resolved' });
			if (notice.dismissible)
				throw new ConflictError('Not resolvable', { error: 'notice_not_resolvable' });
			notice.resolved_at = NOW;
			notice.resolved_by = 'admin-1';
			return { ...notice };
		},
		async publish(input: PublishNoticeInput) {
			await step('publish');
			if (!canWrite || (input.scope_type === 'platform' && !options.platform)) {
				throw new ApiError(403, 'forbidden', 'Forbidden');
			}
			const title = input.title.trim();
			const invalid =
				title.length < 1 ||
				title.length > TITLE_MAX ||
				(input.body?.length ?? 0) > BODY_MAX ||
				(input.link !== undefined && !isConsolePath(input.link)) ||
				(input.scope_type === 'client' && !input.client_id) ||
				(input.scope_type === 'admin_user' && !input.admin_user_id);
			if (invalid) throw new ApiError(400, 'invalid_request', 'Invalid notice');
			sequence += 1;
			const notice = base({
				id: `ntc_new_${sequence}`,
				scope_type: input.scope_type,
				tenant_id: input.scope_type === 'platform' ? null : 'acme',
				client_id: input.client_id ?? null,
				admin_user_id: input.admin_user_id ?? null,
				severity: input.severity,
				source: 'announcement',
				category: 'announcement',
				title,
				body: input.body ?? null,
				link: input.link ?? null,
				created_by: 'admin-1',
				created_at: Date.now(),
				expires_at: input.expires_at ?? null,
				dismissible: input.severity === 'info'
			});
			store.unshift(notice);
			return { ...notice };
		}
	};
}
