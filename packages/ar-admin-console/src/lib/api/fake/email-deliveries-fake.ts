/**
 * In-memory email deliveries for Storybook, tests and the console dev mock. It answers the
 * Admin API's wire format (`GET /api/admin/email-deliveries`: `items` and
 * `recipient_visibility`) for the real query parameters, and the client goes through the same
 * encoding and decoding as the HTTP one. The sample is a tenant's recent day: sign-in codes
 * that went through, one that bounced, an invitation still retrying, a notice the provider
 * rejected, a test mail.
 */
import { ApiError } from '../api-error';
import {
	EMAIL_DELIVERIES_PAGE_SIZE,
	EMAIL_DELIVERY_STATUSES,
	emailDeliveryListFrom,
	emailDeliveryParams,
	type EmailDeliveriesClient,
	type EmailDelivery,
	type EmailDeliveryStatus,
	type RecipientVisibility
} from '../email-deliveries';

export interface FakeEmailDeliveriesOptions {
	/** The records that exist; defaults to `sampleEmailDeliveries()`. */
	items?: EmailDelivery[];
	/** No records at all. */
	empty?: boolean;
	/** How the recipients are shown; defaults to `masked`. */
	visibility?: RecipientVisibility;
	/** Milliseconds each call takes. */
	delay?: number;
	/** Every list call fails with this HTTP status. */
	fail?: 403 | 500;
	/** The list never answers (to show loading). */
	hang?: boolean;
}

/** The "now" of the sample data. */
export const EMAIL_DELIVERIES_NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const MINUTE = 60_000;

interface Sample {
	kind: string;
	account: string | null;
	recipient: string;
	status: EmailDeliveryStatus;
	attempts?: number;
	error?: string;
	/** Minutes before "now" the request was made. */
	ago: number;
	/** Minutes after the request the provider accepted it; absent when it never did. */
	accepted?: number;
	/** Minutes after the request the status last changed; absent when never. */
	updated?: number;
	messageId?: boolean;
}

const SAMPLES: Sample[] = [
	{
		kind: 'auth.direct-email-code',
		account: 'usr_01hv8k2x9m',
		recipient: 'taro.yamada@example.com',
		status: 'delivered',
		ago: 4,
		accepted: 0,
		updated: 1,
		messageId: true
	},
	{
		kind: 'auth.direct-email-code',
		account: 'usr_01hv8k3p2q',
		recipient: 'hanako.sato@example.co.jp',
		status: 'provider_accepted',
		ago: 9,
		accepted: 0,
		messageId: true
	},
	{
		kind: 'admin.admin-invitation',
		account: null,
		recipient: 'new.admin@partner.example',
		status: 'retrying',
		attempts: 3,
		error: 'provider_timeout',
		ago: 17,
		updated: 12
	},
	{
		kind: 'auth.direct-email-code',
		account: 'usr_01hv8k4r7t',
		recipient: 'nobody@bounce.example',
		status: 'bounced',
		attempts: 1,
		error: 'hard_bounce',
		ago: 38,
		accepted: 0,
		updated: 2,
		messageId: true
	},
	{
		kind: 'admin.notice',
		account: null,
		recipient: 'ops@tenant.example',
		status: 'rejected',
		attempts: 1,
		error: 'recipient_suppressed',
		ago: 55,
		updated: 0
	},
	{
		kind: 'account.identifier-replacement-otp',
		account: 'usr_01hv8k5v1w',
		recipient: 'jiro.suzuki@example.com',
		status: 'delivered',
		ago: 83,
		accepted: 0,
		updated: 1,
		messageId: true
	},
	{
		kind: 'admin.test-email',
		account: null,
		recipient: 'admin@tenant.example',
		status: 'delivered',
		ago: 140,
		accepted: 0,
		updated: 1,
		messageId: true
	},
	{
		kind: 'auth.direct-email-code',
		account: 'usr_01hv8k6y4z',
		recipient: 'keiko.tanaka@example.com',
		status: 'expired',
		attempts: 2,
		ago: 300,
		updated: 240
	},
	{
		kind: 'admin.tenant-invitation',
		account: null,
		recipient: 'owner@newtenant.example',
		status: 'deferred',
		attempts: 2,
		error: 'provider_rate_limited',
		ago: 420,
		accepted: 1,
		updated: 30,
		messageId: true
	},
	{
		kind: 'auth.direct-email-code',
		account: 'usr_01hv8k7a8b',
		recipient: 'ichiro.kato@example.com',
		status: 'complained',
		ago: 900,
		accepted: 0,
		updated: 600,
		messageId: true
	},
	{
		kind: 'account.guest-upgrade-otp',
		account: 'usr_01hv8k8c2d',
		recipient: 'guest.user@example.net',
		status: 'failed',
		attempts: 5,
		error: 'provider_unavailable',
		ago: 1300,
		updated: 1200
	},
	{
		kind: 'auth.direct-email-code',
		account: 'usr_01hv8k9e6f',
		recipient: 'mika.ito@example.com',
		status: 'canceled',
		ago: 1390,
		updated: 1385
	}
];

function mask(address: string): string {
	const [local, domain] = address.split('@');
	return `${local.slice(0, 1)}***@${domain ?? ''}`;
}

/** A recent day of send requests, newest first, with the recipients in full. */
export function sampleEmailDeliveries(): EmailDelivery[] {
	return SAMPLES.map((sample, index) => {
		const requested = EMAIL_DELIVERIES_NOW - sample.ago * MINUTE;
		return {
			intent_id: `nint_${String(index + 1).padStart(4, '0')}`,
			account_id: sample.account,
			notification_kind: sample.kind,
			recipient: sample.recipient,
			recipient_visibility: 'full',
			api_status: 'recorded',
			provider_installation_id: 'pin_mailer_primary',
			provider_message_id: sample.messageId ? `msg_${String(index + 1).padStart(6, '0')}` : null,
			status: sample.status,
			final_delivery_tracked: ['delivered', 'bounced', 'complained', 'deferred'].includes(
				sample.status
			),
			attempts: sample.attempts ?? 1,
			last_error_code: sample.error ?? null,
			requested_at: requested,
			provider_accepted_at:
				sample.accepted === undefined ? null : requested + sample.accepted * MINUTE,
			status_updated_at: sample.updated === undefined ? null : requested + sample.updated * MINUTE
		};
	});
}

/** The items as a caller with the given visibility receives them. */
export function projectRecipients(
	items: readonly EmailDelivery[],
	visibility: RecipientVisibility
): EmailDelivery[] {
	return items.map((item) => ({
		...item,
		recipient_visibility: visibility,
		recipient:
			visibility === 'full'
				? item.recipient
				: visibility === 'masked' && item.recipient
					? mask(item.recipient)
					: null
	}));
}

/** The wire answer to a list request, as the Admin API would give it. */
export function answerEmailDeliveriesList(
	params: URLSearchParams,
	all: readonly EmailDelivery[],
	visibility: RecipientVisibility
): { status: number; body: Record<string, unknown> } {
	const status = params.get('status');
	if (status && !(EMAIL_DELIVERY_STATUSES as readonly string[]).includes(status)) {
		return {
			status: 400,
			body: { error: 'invalid_request', error_description: 'Invalid delivery history query.' }
		};
	}
	const limit = Number(params.get('limit') ?? EMAIL_DELIVERIES_PAGE_SIZE);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		return {
			status: 400,
			body: { error: 'invalid_request', error_description: 'Invalid delivery history query.' }
		};
	}
	const items = projectRecipients(
		[...all]
			.sort((a, b) => (b.requested_at ?? 0) - (a.requested_at ?? 0))
			.filter((item) => !status || item.status === status)
			.slice(0, limit),
		visibility
	);
	return { status: 200, body: { items, recipient_visibility: visibility } };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakeEmailDeliveries(
	options: FakeEmailDeliveriesOptions = {}
): EmailDeliveriesClient {
	const items = options.empty ? [] : (options.items ?? sampleEmailDeliveries());
	const visibility = options.visibility ?? 'masked';
	return {
		async list(query) {
			if (options.delay) await wait(options.delay);
			if (options.hang) await new Promise(() => {});
			if (options.fail) {
				throw new ApiError(
					options.fail,
					options.fail === 403 ? 'forbidden' : 'server_error',
					'Could not list'
				);
			}
			const answer = answerEmailDeliveriesList(emailDeliveryParams(query), items, visibility);
			if (answer.status !== 200) {
				throw new ApiError(answer.status, String(answer.body.error), 'Invalid query');
			}
			return emailDeliveryListFrom(answer.body);
		}
	};
}
