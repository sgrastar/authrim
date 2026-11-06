/**
 * How notices leave the console: the signed-in admin's email choices, the Slack channels of a
 * tenant (or of the platform), and where one notice was delivered.
 * `/api/admin/me/notice-preferences` is a /me route, so it is sent without the tenant header.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { stepUpHeaders, withStepUp } from './admin-step-up';
import { ApiError, errorFromResponse } from './api-error';
import type { NotificationSeverity } from '#lib/shell/notifications.js';

export type NoticeChannelScope = 'platform' | 'tenant';
export type DeliveryChannelKind = 'email' | 'slack';
export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'dead_letter' | 'skipped';

export interface NoticePreferences {
	email_enabled: boolean;
	email_min_severity: NotificationSeverity;
	updated_at: number | null;
}

export interface NoticePreferencesInput {
	email_enabled: boolean;
	email_min_severity: NotificationSeverity;
}

/** A Slack channel as the API returns it. The webhook URL itself is never returned. */
export interface NoticeChannel {
	id: string;
	scope_type: NoticeChannelScope;
	tenant_id: string | null;
	kind: 'slack';
	name: string;
	webhook_url_hint: string;
	min_severity: NotificationSeverity;
	enabled: boolean;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface CreateNoticeChannelInput {
	scope_type?: NoticeChannelScope;
	name: string;
	webhook_url: string;
	min_severity?: NotificationSeverity;
	enabled?: boolean;
}

export interface UpdateNoticeChannelInput {
	name?: string;
	min_severity?: NotificationSeverity;
	enabled?: boolean;
}

export interface NoticeDelivery {
	id: string;
	channel: DeliveryChannelKind;
	/** The admin (email) or the channel (Slack) the message went to. */
	target_id: string;
	status: DeliveryStatus;
	attempts: number;
	next_attempt_at: number | null;
	last_error: string | null;
	updated_at: number;
}

/** A page of a notice's deliveries, with counts over all of them. */
export interface NoticeDeliveryPage {
	items: NoticeDelivery[];
	/** Pass back as `after` for the next page; null on the last one. */
	next: string | null;
	summary: Array<{ channel: DeliveryChannelKind; status: DeliveryStatus; count: number }>;
}

export interface ChannelTestResult {
	delivered: boolean;
	error?: string;
}

export interface NoticeDeliveryClient {
	getPreferences(signal?: AbortSignal): Promise<NoticePreferences>;
	setPreferences(input: NoticePreferencesInput): Promise<NoticePreferences>;
	listChannels(signal?: AbortSignal): Promise<NoticeChannel[]>;
	createChannel(input: CreateNoticeChannelInput): Promise<NoticeChannel>;
	updateChannel(id: string, input: UpdateNoticeChannelInput): Promise<NoticeChannel>;
	replaceWebhookUrl(id: string, webhookUrl: string): Promise<NoticeChannel>;
	deleteChannel(id: string): Promise<void>;
	testChannel(id: string): Promise<ChannelTestResult>;
	listDeliveries(
		noticeId: string,
		options?: { after?: string | null; signal?: AbortSignal }
	): Promise<NoticeDeliveryPage>;
}

export const CHANNEL_NAME_MAX = 80;
export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/services/';
export const SEVERITIES: readonly NotificationSeverity[] = ['critical', 'high', 'caution', 'info'];
export const DEFAULT_PREFERENCES: NoticePreferences = {
	email_enabled: true,
	email_min_severity: 'high',
	updated_at: null
};

/** Whether the URL is one a Slack Incoming Webhook can have. */
export const isSlackWebhookUrl = (value: string): boolean =>
	value.startsWith(SLACK_WEBHOOK_PREFIX) && value.length > SLACK_WEBHOOK_PREFIX.length;

// ---------------------------------------------------------------------------------------------
// From the wire

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value !== null && typeof value === 'object' ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const orNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;
const numOrNull = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;
const severityOf = (value: unknown, fallback: NotificationSeverity): NotificationSeverity =>
	SEVERITIES.find((item) => item === value) ?? fallback;

export function preferencesFromRow(value: unknown): NoticePreferences {
	const row = record(value);
	return {
		email_enabled:
			typeof row.email_enabled === 'boolean'
				? row.email_enabled
				: DEFAULT_PREFERENCES.email_enabled,
		email_min_severity: severityOf(row.email_min_severity, DEFAULT_PREFERENCES.email_min_severity),
		updated_at: numOrNull(row.updated_at)
	};
}

export function channelFromRow(value: unknown): NoticeChannel {
	const row = record(value);
	return {
		id: text(row.id),
		scope_type: row.scope_type === 'platform' ? 'platform' : 'tenant',
		tenant_id: orNull(row.tenant_id),
		kind: 'slack',
		name: text(row.name),
		webhook_url_hint: text(row.webhook_url_hint),
		min_severity: severityOf(row.min_severity, 'high'),
		enabled: row.enabled === true,
		created_by: orNull(row.created_by),
		created_at: numOrNull(row.created_at) ?? 0,
		updated_at: numOrNull(row.updated_at) ?? 0
	};
}

const STATUSES: readonly DeliveryStatus[] = ['queued', 'sent', 'failed', 'dead_letter', 'skipped'];

export function deliveryFromRow(value: unknown): NoticeDelivery {
	const row = record(value);
	return {
		id: text(row.id),
		channel: row.channel === 'slack' ? 'slack' : 'email',
		target_id: text(row.target_id),
		status: STATUSES.find((item) => item === row.status) ?? 'queued',
		attempts: numOrNull(row.attempts) ?? 0,
		next_attempt_at: numOrNull(row.next_attempt_at),
		last_error: orNull(row.last_error),
		updated_at: numOrNull(row.updated_at) ?? 0
	};
}

/** The form field the API refused (`webhook_url`, `name`…), when it says which. */
export function deliveryErrorField(error: unknown): string | undefined {
	if (error instanceof ApiError && typeof error.body.field === 'string') return error.body.field;
	return undefined;
}

/** The API cannot keep webhook URLs safely until its encryption is set up (503). */
export const isTemporarilyUnavailable = (error: unknown): boolean =>
	error instanceof ApiError && error.status === 503;

// ---------------------------------------------------------------------------------------------
// Over HTTP

const ME = `${API_BASE_URL}/api/admin/me/notice-preferences`;
const CHANNELS = `${API_BASE_URL}/api/admin/notice-channels`;
const NOTICES = `${API_BASE_URL}/api/admin/notices`;

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	return record(await response.json().catch(() => ({})));
}

const json = (
	method: string,
	body: unknown
): RequestInit & { includeJsonContentType: boolean } => ({
	method,
	includeJsonContentType: true,
	body: JSON.stringify(body)
});

const withReceipt = <T extends RequestInit>(init: T, receipt?: string): T => ({
	...init,
	headers: stepUpHeaders(receipt)
});

const channelUrl = (id: string) => `${CHANNELS}/${encodeURIComponent(id)}`;

export const httpNoticeDelivery: NoticeDeliveryClient = {
	async getPreferences(signal) {
		const body = await readJson(await adminFetch(ME, { signal, skipTenantHeader: true }));
		return preferencesFromRow(body.preferences);
	},
	async setPreferences(input) {
		const body = await readJson(
			await adminFetch(ME, { ...json('PUT', input), skipTenantHeader: true })
		);
		return preferencesFromRow(body.preferences);
	},
	async listChannels(signal) {
		const body = await readJson(await adminFetch(CHANNELS, { signal }));
		return (Array.isArray(body.items) ? body.items : []).map(channelFromRow);
	},
	async createChannel(input) {
		const body = await withStepUp(async (receipt) =>
			readJson(await adminFetch(CHANNELS, withReceipt(json('POST', input), receipt)))
		);
		return channelFromRow(body.channel);
	},
	async updateChannel(id, input) {
		const body = await readJson(await adminFetch(channelUrl(id), json('PATCH', input)));
		return channelFromRow(body.channel);
	},
	async replaceWebhookUrl(id, webhookUrl) {
		const body = await withStepUp(
			async (receipt) =>
				readJson(
					await adminFetch(
						`${channelUrl(id)}/webhook-url`,
						withReceipt(json('PUT', { webhook_url: webhookUrl }), receipt)
					)
				),
			undefined,
			{ operation: 'webhook.destination.update' }
		);
		return channelFromRow(body.channel);
	},
	async deleteChannel(id) {
		await readJson(await adminFetch(channelUrl(id), { method: 'DELETE' }));
	},
	async testChannel(id) {
		const body = await readJson(await adminFetch(`${channelUrl(id)}/test`, { method: 'POST' }));
		return {
			delivered: body.delivered === true,
			...(typeof body.error === 'string' ? { error: body.error } : {})
		};
	},
	async listDeliveries(noticeId, options = {}) {
		const query = options.after ? `?after=${encodeURIComponent(options.after)}` : '';
		const body = await readJson(
			await adminFetch(`${NOTICES}/${encodeURIComponent(noticeId)}/deliveries${query}`, {
				signal: options.signal
			})
		);
		const items = (Array.isArray(body.items) ? body.items : []).map(deliveryFromRow);
		const summary = (Array.isArray(body.summary) ? body.summary : []).map((value) => {
			const row = deliveryFromRow({ ...(value as object), id: 'summary' });
			const count = (value as { count?: unknown }).count;
			return {
				channel: row.channel,
				status: row.status,
				count: typeof count === 'number' ? count : 0
			};
		});
		return {
			items,
			next: typeof body.next_cursor === 'string' ? body.next_cursor : null,
			summary
		};
	}
};
