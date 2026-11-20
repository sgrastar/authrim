import { adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

/**
 * Saving a profile (an output or an input source) is one action: it is written, reviewed and
 * switched on in turn. The chain stops at the first step the server refuses; what was written
 * stays (a new profile as a draft, an edit as a draft version beside the one in use) and the
 * caller says why.
 */
export interface ProfileWritten {
	id: string;
	versionId: string | undefined;
	state: string | undefined;
}

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function profileRequest(
	tenantId: string,
	url: string,
	method: string,
	body?: unknown
): Promise<Response> {
	return adminFetch(url, {
		tenantId,
		method,
		headers: { 'Idempotency-Key': crypto.randomUUID() },
		includeJsonContentType: true,
		body: JSON.stringify(body ?? {})
	});
}

export async function profileJson(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw await errorFromResponse(response);
	return record(await response.json());
}

/** The written profile's identity, read from a create or update answer. */
export function readWritten(result: unknown): {
	written: Record<string, unknown>;
	info: ProfileWritten;
} {
	const written = record(result);
	const version = record(written.version);
	return {
		written,
		info: {
			id: String(written.id),
			versionId: typeof version.id === 'string' ? version.id : undefined,
			state:
				typeof version.lifecycleState === 'string'
					? version.lifecycleState
					: typeof written.lifecycleState === 'string'
						? written.lifecycleState
						: undefined
		}
	};
}

/**
 * Reviews and activates a written version. Returns whether it is now active; a refusal is
 * returned as `reason` rather than thrown (the profile was written).
 */
export async function reviewAndActivate(
	tenantId: string,
	base: string,
	info: ProfileWritten
): Promise<{ active: boolean; reason?: string }> {
	let state = info.state;
	const versions = `${base}/${encodeURIComponent(info.id)}/versions/${encodeURIComponent(info.versionId ?? '')}`;
	try {
		if (state === 'draft' && info.versionId) {
			await profileJson(await profileRequest(tenantId, `${versions}/review`, 'POST'));
			state = 'reviewed';
		}
		if (state === 'reviewed' && info.versionId) {
			await profileJson(await profileRequest(tenantId, `${versions}/activate`, 'POST'));
			state = 'active';
		}
	} catch (error) {
		return { active: false, reason: error instanceof Error ? error.message : '' };
	}
	return { active: state === 'active' };
}
