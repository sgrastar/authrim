/**
 * Email deliveries: the evidence that Authrim recorded a send request and that the configured
 * provider accepted it (`GET /api/admin/email-deliveries`, `admin:email_deliveries:read`).
 * A provider's acceptance is not inbox delivery; `final_delivery_tracked` says whether a later
 * status (delivered, bounced, complained) came back from the provider at all.
 *
 * The recipient is omitted, masked or in full according to two further permissions the server
 * applies (`recipient_visibility`); a full read is itself audited there. Message bodies,
 * template variables and codes are never returned. The list is the newest records of the
 * selected tenant, up to a limit; there is no cursor and no period.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

export const EMAIL_DELIVERY_STATUSES = [
	'requested',
	'retrying',
	'provider_accepted',
	'delivered',
	'deferred',
	'bounced',
	'failed',
	'rejected',
	'complained',
	'unknown',
	'expired',
	'canceled'
] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export type RecipientVisibility = 'full' | 'masked' | 'none';

/** One send request, as the Admin API returns it. */
export interface EmailDelivery {
	intent_id: string;
	/** The end user it was sent to, when it was a user's message. */
	account_id: string | null;
	/** What kind of message (`auth.direct-email-code`, `admin.admin-invitation`, …). */
	notification_kind: string;
	/** Omitted (null), masked or full, as `recipient_visibility` says. */
	recipient: string | null;
	recipient_visibility: RecipientVisibility;
	api_status: 'recorded';
	provider_installation_id: string;
	provider_message_id: string | null;
	status: EmailDeliveryStatus;
	/** A final status (delivered, bounced, …) came back from the provider. */
	final_delivery_tracked: boolean;
	attempts: number;
	last_error_code: string | null;
	/** Epoch milliseconds. */
	requested_at: number | null;
	provider_accepted_at: number | null;
	status_updated_at: number | null;
}

export interface EmailDeliveryQuery {
	status?: EmailDeliveryStatus;
	/** 1–100; the API's default is 50. */
	limit?: number;
}

export interface EmailDeliveryList {
	items: EmailDelivery[];
	/** How the recipients of this list are shown to the caller. */
	recipientVisibility: RecipientVisibility;
}

export interface EmailDeliveriesClient {
	list(query: EmailDeliveryQuery, signal?: AbortSignal): Promise<EmailDeliveryList>;
}

export const EMAIL_DELIVERIES_PAGE_SIZE = 50;
export const EMAIL_DELIVERIES_MAX = 100;

/** The query string of a list request. */
export function emailDeliveryParams(query: EmailDeliveryQuery): URLSearchParams {
	const params = new URLSearchParams();
	params.set('limit', String(query.limit ?? EMAIL_DELIVERIES_PAGE_SIZE));
	if (query.status) params.set('status', query.status);
	return params;
}

interface ListBody {
	items?: unknown;
	recipient_visibility?: unknown;
}

/** A list response as the client's shape. */
export function emailDeliveryListFrom(body: ListBody): EmailDeliveryList {
	const items = Array.isArray(body.items)
		? (body.items as EmailDelivery[]).filter(
				(item) => item && typeof item.intent_id === 'string' && typeof item.status === 'string'
			)
		: [];
	const visibility = body.recipient_visibility;
	return {
		items,
		recipientVisibility: visibility === 'full' || visibility === 'masked' ? visibility : 'none'
	};
}

export const httpEmailDeliveries: EmailDeliveriesClient = {
	async list(query, signal) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/email-deliveries?${emailDeliveryParams(query)}`,
			{ signal }
		);
		if (!response.ok) throw await errorFromResponse(response);
		return emailDeliveryListFrom((await response.json()) as ListBody);
	}
};
