/**
 * The access check for administrators (`POST /api/admin/access-check`): whether one of the
 * tenant's users may do something, with the reasons. It runs the same check as the public Check
 * API (`/api/check`) under its server contract, with the debug details (the matched rules, the
 * ReBAC path, the time it took), and writes nothing. Needs `admin:roles:read` or
 * `admin:groups:read`; `feature.enable_check_api` does not apply to it.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { MalformedResponseError } from './end-user-groups';

export type ResolvedVia = 'direct' | 'role' | 'group_role' | 'rebac' | 'id_level' | 'computed';

export interface AccessCheckInput {
	subject_id: string;
	/** `resource:action`. */
	permission: string;
	/** One resource of that type: asks `resource:<id>:action`. */
	resource_id?: string;
	/** The group the resource belongs to (a role granted for that group holds for it). */
	resource_group_id?: string;
	/** Who owns the resource. */
	owner_id?: string;
	/** A relationship to check as well (ReBAC): both or neither. */
	rebac?: { relation: string; object: string };
}

export interface AccessCheckResult {
	allowed: boolean;
	resolved_via: string[];
	final_decision: 'allow' | 'deny';
	reason: string | null;
	matched_rules: string[];
	path: string[];
	evaluation_time_ms: number | null;
}

export interface AccessCheckClient {
	check(input: AccessCheckInput, signal?: AbortSignal): Promise<AccessCheckResult>;
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The request body: the permission as a string, or as an object when it names one resource. */
export function accessCheckBody(input: AccessCheckInput): Record<string, unknown> {
	const [resource = '', ...rest] = input.permission.trim().split(':');
	const action = rest.join(':');
	const id = input.resource_id?.trim();
	const context: Record<string, string> = {};
	if (input.resource_group_id?.trim()) context.group_id = input.resource_group_id.trim();
	if (input.owner_id?.trim()) context.owner_id = input.owner_id.trim();
	return {
		subject_id: input.subject_id.trim(),
		permission: id ? { resource, id, action } : input.permission.trim(),
		...(Object.keys(context).length ? { resource_context: context } : {}),
		...(input.rebac?.relation.trim() && input.rebac.object.trim()
			? { rebac: { relation: input.rebac.relation.trim(), object: input.rebac.object.trim() } }
			: {})
	};
}

/** A check answer without a decision is a failure, never "denied". */
export function accessCheckResultFrom(value: unknown): AccessCheckResult {
	const row = record(value);
	if (typeof row.allowed !== 'boolean') throw new MalformedResponseError('allowed is missing');
	const debug = record(row.debug);
	const allowed = row.allowed === true;
	return {
		allowed,
		resolved_via: strings(row.resolved_via),
		final_decision: row.final_decision === 'allow' || allowed ? 'allow' : 'deny',
		reason: typeof row.reason === 'string' && row.reason ? row.reason : null,
		matched_rules: strings(debug.matched_rules),
		path: strings(debug.path),
		evaluation_time_ms:
			typeof debug.evaluation_time_ms === 'number' ? debug.evaluation_time_ms : null
	};
}

export function httpAccessCheck(tenantId: string): AccessCheckClient {
	return {
		async check(input, signal) {
			const response = await adminFetch(`${API_BASE_URL}/api/admin/access-check`, {
				method: 'POST',
				signal,
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify(accessCheckBody(input))
			});
			if (!response.ok) throw await errorFromResponse(response);
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				throw new MalformedResponseError('not JSON');
			}
			return accessCheckResultFrom(body);
		}
	};
}
