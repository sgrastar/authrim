import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

/**
 * The tenant's Flows (`/api/admin/flows`) and which one runs for the tenant
 * (`/api/admin/flow-assignments`), as far as the service-flow pages need them.
 */
export interface FlowRecord {
	id: string;
	displayName: string;
	kind: string;
	status: 'draft' | 'published' | 'disabled';
	/** The draft graph (`FlowEditorState`), as saved. */
	editor: unknown;
	publishedVersionId: string | null;
	createdAt: number | null;
	updatedAt: number | null;
}

export interface FlowsClient {
	/** The Flow of this kind the tenant runs (its tenant assignment), or null when there is none. */
	tenantFlow(kind: string, signal?: AbortSignal): Promise<FlowRecord | null>;
	create(input: { kind: string; displayName: string; editor: unknown }): Promise<FlowRecord>;
	update(id: string, input: { displayName: string; editor: unknown }): Promise<FlowRecord>;
	/** Publishes the draft as a new version; refused (with its issues) when it cannot run. */
	publish(id: string): Promise<void>;
	/** Makes the Flow the one the tenant runs for its kind. */
	assignToTenant(id: string, kind: string): Promise<void>;
}

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function flowFromRow(value: unknown): FlowRecord {
	const row = object(value);
	const status = row.status === 'published' || row.status === 'disabled' ? row.status : 'draft';
	return {
		id: typeof row.id === 'string' ? row.id : '',
		displayName: typeof row.display_name === 'string' ? row.display_name : '',
		kind: typeof row.kind === 'string' ? row.kind : '',
		status,
		editor: row.editor ?? null,
		publishedVersionId:
			typeof row.published_version_id === 'string' ? row.published_version_id : null,
		createdAt: typeof row.created_at === 'number' ? row.created_at : null,
		updatedAt: typeof row.updated_at === 'number' ? row.updated_at : null
	};
}

async function body(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw await errorFromResponse(response);
	return object(await response.json().catch(() => ({})));
}

const json = (method: string, payload: unknown) => ({
	method,
	includeJsonContentType: true,
	body: JSON.stringify(payload)
});

const FLOWS = `${API_BASE_URL}/api/admin/flows`;
const ASSIGNMENTS = `${API_BASE_URL}/api/admin/flow-assignments`;

export const httpFlows: FlowsClient = {
	async tenantFlow(kind, signal) {
		const listed = await body(await adminFetch(`${ASSIGNMENTS}?target_type=tenant`, { signal }));
		const assignment = (Array.isArray(listed.assignments) ? listed.assignments : [])
			.map(object)
			.find((row) => row.flow_kind === kind && row.target_id === null && row.enabled !== false);
		if (!assignment || typeof assignment.flow_id !== 'string') return null;
		const read = await body(
			await adminFetch(`${FLOWS}/${encodeURIComponent(assignment.flow_id)}`, { signal })
		);
		return flowFromRow(read.flow);
	},
	async create(input) {
		const created = await body(
			await adminFetch(
				FLOWS,
				json('POST', { kind: input.kind, display_name: input.displayName, editor: input.editor })
			)
		);
		return flowFromRow(created.flow);
	},
	async update(id, input) {
		const updated = await body(
			await adminFetch(
				`${FLOWS}/${encodeURIComponent(id)}`,
				json('PATCH', { display_name: input.displayName, editor: input.editor })
			)
		);
		return flowFromRow(updated.flow);
	},
	async publish(id) {
		await body(await adminFetch(`${FLOWS}/${encodeURIComponent(id)}/publish`, { method: 'POST' }));
	},
	async assignToTenant(id, kind) {
		await body(
			await adminFetch(
				ASSIGNMENTS,
				json('PUT', { target_type: 'tenant', flow_kind: kind, flow_id: id, enabled: true })
			)
		);
	}
};
