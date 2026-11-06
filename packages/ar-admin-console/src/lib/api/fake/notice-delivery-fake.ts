/**
 * In-memory notice delivery API for Storybook and tests. Follows the Admin API's rules: the
 * webhook URL must be a Slack Incoming Webhook, it is never kept or returned (only a hint of
 * its end), platform channels need platform authority, and writes need settings write access.
 */
import type { FakeStepUp } from './step-up-fake';
import { ApiError } from '../api-error';
import {
	CHANNEL_NAME_MAX,
	DEFAULT_PREFERENCES,
	SEVERITIES,
	isSlackWebhookUrl,
	type CreateNoticeChannelInput,
	type NoticeChannel,
	type NoticeDelivery,
	type NoticeDeliveryPage,
	type NoticeDeliveryClient,
	type NoticePreferences
} from '../notice-delivery';

type Call =
	| 'getPreferences'
	| 'setPreferences'
	| 'listChannels'
	| 'createChannel'
	| 'updateChannel'
	| 'replaceWebhookUrl'
	| 'deleteChannel'
	| 'testChannel'
	| 'listDeliveries';

export interface FakeNoticeDeliveryOptions {
	preferences?: Partial<NoticePreferences>;
	channels?: NoticeChannel[];
	/** Deliveries per notice id; defaults to `sampleDeliveries()` for every notice. */
	deliveries?: Record<string, NoticeDelivery[]>;
	/** Deliveries per page (200, as the API). */
	deliveryPageSize?: number;
	/** Milliseconds each call takes. */
	delay?: number;
	/** Fail every call with this status. */
	fail?: 403 | 500 | 503;
	/** Fail only these calls (the list loads, an action fails). */
	failOn?: Partial<Record<Call, 400 | 403 | 404 | 500 | 503>>;
	/** The signed-in admin holds platform authority (read on each call when a function). */
	platform?: boolean | (() => boolean);
	/** The signed-in admin may change channels (`admin:settings:write`). */
	canWrite?: boolean;
	/** The test message is refused by Slack with this reason. */
	testError?: string;
	/** Step-up for the operations that need it (the mock asks through the console's dialog). */
	stepUp?: FakeStepUp;
}

const NOW = Date.UTC(2026, 10, 4, 3, 0, 0);

export function sampleChannels(): NoticeChannel[] {
	return [
		{
			id: 'nch_ops',
			scope_type: 'tenant',
			tenant_id: 'acme',
			kind: 'slack',
			name: '#ops-alerts',
			webhook_url_hint: '…x4Kq',
			min_severity: 'high',
			enabled: true,
			created_by: 'admin-1',
			created_at: NOW - 86_400_000,
			updated_at: NOW - 3_600_000
		},
		{
			id: 'nch_all',
			scope_type: 'tenant',
			tenant_id: 'acme',
			kind: 'slack',
			name: '#identity-notices',
			webhook_url_hint: '…9aZp',
			min_severity: 'info',
			enabled: false,
			created_by: 'admin-2',
			created_at: NOW - 5 * 86_400_000,
			updated_at: NOW - 2 * 86_400_000
		},
		{
			id: 'nch_platform',
			scope_type: 'platform',
			tenant_id: null,
			kind: 'slack',
			name: '#platform-oncall',
			webhook_url_hint: '…Lm02',
			min_severity: 'critical',
			enabled: true,
			created_by: 'admin-1',
			created_at: NOW - 9 * 86_400_000,
			updated_at: NOW - 9 * 86_400_000
		}
	];
}

export function sampleDeliveries(): NoticeDelivery[] {
	return [
		{
			id: 'ndl_1',
			channel: 'email',
			target_id: 'admin-1',
			status: 'sent',
			attempts: 1,
			next_attempt_at: null,
			last_error: null,
			updated_at: NOW
		},
		{
			id: 'ndl_2',
			channel: 'email',
			target_id: 'admin-2',
			status: 'skipped',
			attempts: 0,
			next_attempt_at: null,
			last_error: null,
			updated_at: NOW
		},
		{
			id: 'ndl_3',
			channel: 'slack',
			target_id: 'nch_ops',
			status: 'failed',
			attempts: 2,
			next_attempt_at: NOW + 5 * 60_000,
			last_error: 'invalid_webhook',
			updated_at: NOW
		}
	];
}

const hintOf = (url: string) => `…${url.slice(-4)}`;

export function createFakeNoticeDelivery(
	options: FakeNoticeDeliveryOptions = {}
): NoticeDeliveryClient {
	const canWrite = options.canWrite ?? true;
	const platform = () =>
		typeof options.platform === 'function' ? options.platform() : (options.platform ?? false);
	let preferences: NoticePreferences = { ...DEFAULT_PREFERENCES, ...options.preferences };
	const channels = (options.channels ?? sampleChannels()).map((channel) => ({ ...channel }));
	let sequence = 0;

	async function step(call: Call, write: boolean, signal?: AbortSignal) {
		if (options.delay) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, options.delay);
				signal?.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new DOMException('cancelled', 'AbortError'));
				});
			});
		}
		const status = options.fail ?? options.failOn?.[call];
		if (status === 400) {
			throw new ApiError(400, 'invalid_request', 'Invalid', { field: 'webhook_url' });
		}
		if (status === 503) throw new ApiError(503, 'temporarily_unavailable', 'Unavailable');
		if (status) throw new ApiError(status, status === 403 ? 'forbidden' : 'error', `${status}`);
		if (write && !canWrite) throw new ApiError(403, 'forbidden', 'Forbidden');
	}

	const visible = (channel: NoticeChannel) => channel.scope_type !== 'platform' || platform();

	const find = (id: string) => {
		const channel = channels.find((item) => item.id === id);
		if (!channel || !visible(channel)) throw new ApiError(404, 'not_found', 'Not found');
		return channel;
	};

	const refuse = (field: string): never => {
		throw new ApiError(400, 'invalid_request', `Invalid ${field}`, { field });
	};

	const checkName = (name: string) => {
		const trimmed = name.trim();
		if (!trimmed || trimmed.length > CHANNEL_NAME_MAX) refuse('name');
		return trimmed;
	};
	const checkUrl = (url: string) => {
		if (!isSlackWebhookUrl(url.trim())) refuse('webhook_url');
		return url.trim();
	};

	return {
		async getPreferences(signal) {
			await step('getPreferences', false, signal);
			return { ...preferences };
		},
		async setPreferences(input) {
			await step('setPreferences', false);
			if (!SEVERITIES.includes(input.email_min_severity)) refuse('email_min_severity');
			preferences = { ...input, updated_at: Date.now() };
			return { ...preferences };
		},
		async listChannels(signal) {
			await step('listChannels', false, signal);
			return channels.filter(visible).map((channel) => ({ ...channel }));
		},
		async createChannel(input: CreateNoticeChannelInput) {
			await step('createChannel', true);
			const scope = input.scope_type ?? 'tenant';
			if (scope === 'platform' && !platform()) throw new ApiError(403, 'forbidden', 'Forbidden');
			const name = checkName(input.name);
			const url = checkUrl(input.webhook_url);
			if (input.min_severity && !SEVERITIES.includes(input.min_severity)) refuse('min_severity');
			sequence += 1;
			// The URL is used once and dropped; only the hint of its end is kept.
			const channel: NoticeChannel = {
				id: `nch_new_${sequence}`,
				scope_type: scope,
				tenant_id: scope === 'platform' ? null : 'acme',
				kind: 'slack',
				name,
				webhook_url_hint: hintOf(url),
				min_severity: input.min_severity ?? 'high',
				enabled: input.enabled ?? true,
				created_by: 'admin-1',
				created_at: Date.now(),
				updated_at: Date.now()
			};
			channels.push(channel);
			return { ...channel };
		},
		async updateChannel(id, input) {
			await step('updateChannel', true);
			const channel = find(id);
			if (input.name !== undefined) channel.name = checkName(input.name);
			if (input.min_severity !== undefined) {
				if (!SEVERITIES.includes(input.min_severity)) refuse('min_severity');
				channel.min_severity = input.min_severity;
			}
			if (input.enabled !== undefined) channel.enabled = input.enabled;
			channel.updated_at = Date.now();
			return { ...channel };
		},
		async replaceWebhookUrl(id, webhookUrl) {
			const replace = async () => {
				await step('replaceWebhookUrl', true);
				const channel = find(id);
				channel.webhook_url_hint = hintOf(checkUrl(webhookUrl));
				channel.updated_at = Date.now();
				return { ...channel };
			};
			return options.stepUp ? options.stepUp.run('webhook.destination.update', replace) : replace();
		},
		async deleteChannel(id) {
			await step('deleteChannel', true);
			const channel = find(id);
			channels.splice(channels.indexOf(channel), 1);
		},
		async testChannel(id) {
			await step('testChannel', true);
			find(id);
			return options.testError
				? { delivered: false, error: options.testError }
				: { delivered: true };
		},
		async listDeliveries(noticeId, { after = null, signal } = {}) {
			await step('listDeliveries', false, signal);
			const all = (options.deliveries?.[noticeId] ?? sampleDeliveries()).map((item) => ({
				...item
			}));
			const start = after ? all.findIndex((item) => item.id === after) + 1 : 0;
			const size = options.deliveryPageSize ?? 200;
			const items = all.slice(start, start + size);
			const counts = new Map<string, NoticeDeliveryPage['summary'][number]>();
			for (const item of all) {
				const key = `${item.channel}:${item.status}`;
				const entry = counts.get(key) ?? { channel: item.channel, status: item.status, count: 0 };
				entry.count += 1;
				counts.set(key, entry);
			}
			return {
				items,
				next: start + size < all.length ? (items[items.length - 1]?.id ?? null) : null,
				summary: [...counts.values()]
			};
		}
	};
}
