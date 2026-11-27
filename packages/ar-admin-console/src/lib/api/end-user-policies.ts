/**
 * The tenant's policy rules (`/api/admin/policies`): attribute-based rules the Check API
 * evaluates after roles, per-resource permissions and relationships (needs
 * `feature.enable_abac`). Each rule is an effect (allow or deny), the resource types and actions
 * it covers (none: all), a priority and conditions that must all hold. Reading needs
 * `admin:roles:read`; creating, changing, deleting and simulating `admin:roles:write` (the
 * simulation also `admin:policy:simulate`).
 *
 * Rules are additive: a deny does not take back a permission a role already gave.
 *
 * The condition vocabulary comes from `GET /api/admin/policies/condition-types`, so the editor
 * follows whatever the API can evaluate. Times are milliseconds here (the API sends seconds).
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { stepUpHeaders, withStepUp } from './admin-step-up';
import { errorFromResponse } from './api-error';
import { MalformedResponseError, msOrNull, type Paged } from './end-user-groups';

export type PolicyEffect = 'allow' | 'deny';

export interface PolicyCondition {
	type: string;
	params: Record<string, unknown>;
}

export interface PolicyRule {
	id: string;
	name: string;
	description: string | null;
	priority: number;
	effect: PolicyEffect;
	/** Empty: every resource type. */
	resource_types: string[];
	/** Empty: every action. */
	actions: string[];
	conditions: PolicyCondition[];
	enabled: boolean;
	created_at: number | null;
	updated_at: number | null;
}

export interface PolicyInput {
	name: string;
	description: string;
	priority: number;
	effect: PolicyEffect;
	resource_types: string[];
	actions: string[];
	conditions: PolicyCondition[];
	enabled: boolean;
}

export interface PolicyListQuery {
	enabled?: boolean;
	search?: string;
	page?: number;
	limit?: number;
}

/** A parameter of a condition type, as the API describes it (`string`, `number`, `string[]`…). */
export interface ConditionParam {
	name: string;
	type: string;
	required: boolean;
	label: string;
}

export interface ConditionTypeInfo {
	type: string;
	category: string;
	label: string;
	description: string;
	params: ConditionParam[];
}

export interface ConditionCategory {
	id: string;
	label: string;
}

export interface ConditionTypes {
	types: ConditionTypeInfo[];
	categories: ConditionCategory[];
}

export interface PolicySimulationInput {
	subject_id: string;
	/**
	 * The subject's groups. Null: the server resolves them from the account (`groupIds` is left
	 * out); a list, even an empty one, is used as given (an empty list: explicitly no groups).
	 */
	group_ids: string[] | null;
	/** Names of roles the subject holds, for the rules' role conditions. */
	role_names: string[];
	resource_type: string;
	resource_id: string;
	resource_group_ids: string[];
	/** Who owns the resource (for `is_resource_owner`); empty: no owner. */
	owner_id: string;
	/** The subject's verified attributes, for the attribute conditions. */
	attributes: { name: string; value: string }[];
	action: string;
	/** UNIX milliseconds; null: now. */
	timestamp: number | null;
}

export interface PolicySimulation {
	allowed: boolean;
	reason: string;
	decided_by: string | null;
	/** What the decision rests on; says whether groups were resolved, given or unknown. */
	details: Record<string, unknown> | null;
	evaluated_rules: number | null;
}

export interface EndUserPoliciesClient {
	list(query?: PolicyListQuery, signal?: AbortSignal): Promise<Paged<PolicyRule>>;
	get(ruleId: string, signal?: AbortSignal): Promise<PolicyRule>;
	/** Conditions the API cannot evaluate answer 400. */
	create(input: PolicyInput): Promise<{ id: string }>;
	update(ruleId: string, changes: Partial<PolicyInput>): Promise<void>;
	remove(ruleId: string): Promise<void>;
	conditionTypes(signal?: AbortSignal): Promise<ConditionTypes>;
	simulate(input: PolicySimulationInput, signal?: AbortSignal): Promise<PolicySimulation>;
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] =>
	rows(value).filter((item): item is string => typeof item === 'string');
/** A whole number; a numeric string too (a BIGINT column comes as text from PostgreSQL). */
const whole = (value: unknown, fallback: number): number => {
	const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
};

export function policyFromRow(value: unknown): PolicyRule {
	const row = record(value);
	return {
		id: text(row.id),
		name: text(row.name),
		description: text(row.description) || null,
		priority: whole(row.priority, 100),
		effect: row.effect === 'deny' ? 'deny' : 'allow',
		resource_types: strings(row.resource_types),
		actions: strings(row.actions),
		conditions: rows(row.conditions).map((item) => {
			const condition = record(item);
			return { type: text(condition.type), params: record(condition.params) };
		}),
		enabled: row.enabled !== false,
		created_at: msOrNull(row.created_at),
		updated_at: msOrNull(row.updated_at)
	};
}

export function conditionTypesFromBody(body: Row): ConditionTypes {
	return {
		types: rows(body.condition_types).map((item) => {
			const row = record(item);
			return {
				type: text(row.type),
				category: text(row.category),
				label: text(row.label) || text(row.type),
				description: text(row.description),
				params: rows(row.params).map((param) => {
					const spec = record(param);
					return {
						name: text(spec.name),
						type: text(spec.type) || 'string',
						required: spec.required === true,
						label: text(spec.label) || text(spec.name)
					};
				})
			};
		}),
		categories: rows(body.categories).map((item) => {
			const row = record(item);
			return { id: text(row.id), label: text(row.label) || text(row.id) };
		})
	};
}

/** The request body of a simulation: the context as the policy engine reads it. */
export function simulationBody(input: PolicySimulationInput): Record<string, unknown> {
	return {
		context: {
			subject: {
				id: input.subject_id.trim(),
				roles: input.role_names.map((name) => ({ name, scope: 'global' })),
				...(input.group_ids !== null ? { groupIds: input.group_ids } : {}),
				...(input.attributes.length > 0
					? {
							verifiedAttributes: input.attributes.map((attribute) => ({
								name: attribute.name,
								value: attribute.value,
								source: 'manual'
							}))
						}
					: {})
			},
			resource: {
				type: input.resource_type.trim(),
				id: input.resource_id.trim(),
				...(input.owner_id.trim() ? { ownerId: input.owner_id.trim() } : {}),
				...(input.resource_group_ids.length > 0 ? { groupIds: input.resource_group_ids } : {})
			},
			action: { name: input.action.trim() },
			...(input.timestamp !== null ? { timestamp: input.timestamp } : {})
		},
		save_history: false
	};
}

export function simulationFromBody(body: Row): PolicySimulation {
	if (typeof body.allowed !== 'boolean') throw new MalformedResponseError('allowed is missing');
	const details = record(body.details);
	return {
		allowed: body.allowed,
		reason: text(body.reason),
		decided_by: text(body.decided_by) || null,
		details: Object.keys(details).length > 0 ? details : null,
		evaluated_rules: typeof body.evaluated_rules === 'number' ? body.evaluated_rules : null
	};
}

/** The request body of a create or an update: what is given, trimmed. */
export function policyBody(input: Partial<PolicyInput>): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (input.name !== undefined) body.name = input.name.trim();
	if (input.description !== undefined) body.description = input.description.trim();
	if (input.priority !== undefined) body.priority = input.priority;
	if (input.effect !== undefined) body.effect = input.effect;
	if (input.resource_types !== undefined) body.resource_types = input.resource_types;
	if (input.actions !== undefined) body.actions = input.actions;
	if (input.conditions !== undefined) body.conditions = input.conditions;
	if (input.enabled !== undefined) body.enabled = input.enabled;
	return body;
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	try {
		return record(await response.json());
	} catch {
		throw new MalformedResponseError('not JSON');
	}
}

export function httpEndUserPolicies(tenantId: string): EndUserPoliciesClient {
	const base = `${API_BASE_URL}/api/admin/policies`;
	const ruleUrl = (ruleId: string) => `${base}/${encodeURIComponent(ruleId)}`;
	const get = (url: string, signal?: AbortSignal) => adminFetch(url, { signal, tenantId });
	const write = (url: string, method: string, body?: unknown) =>
		withStepUp(async (receipt) =>
			readJson(
				await adminFetch(url, {
					method,
					tenantId,
					headers: stepUpHeaders(receipt),
					...(body === undefined
						? {}
						: { includeJsonContentType: true, body: JSON.stringify(body) })
				})
			)
		);
	return {
		async list(query = {}, signal) {
			const params = new URLSearchParams();
			if (query.enabled !== undefined) params.set('enabled', String(query.enabled));
			if (query.search) params.set('search', query.search);
			if (query.page) params.set('page', String(query.page));
			if (query.limit) params.set('limit', String(query.limit));
			const search = params.toString();
			const body = await readJson(await get(`${base}${search ? `?${search}` : ''}`, signal));
			const pagination = record(body.pagination);
			const items = rows(body.rules).map(policyFromRow);
			const page = whole(pagination.page, 1);
			const total = whole(pagination.total, items.length);
			const limit = whole(pagination.limit, items.length);
			return { items, page, limit, total, hasNext: page * limit < total };
		},
		async get(ruleId, signal) {
			const body = await readJson(await get(ruleUrl(ruleId), signal));
			return policyFromRow(body.rule ?? body);
		},
		async create(input) {
			const body = await write(base, 'POST', policyBody(input));
			const id = text(body.rule_id);
			if (!id) throw new MalformedResponseError('rule_id is missing');
			return { id };
		},
		async update(ruleId, changes) {
			await write(ruleUrl(ruleId), 'PUT', policyBody(changes));
		},
		async remove(ruleId) {
			await write(ruleUrl(ruleId), 'DELETE');
		},
		async conditionTypes(signal) {
			return conditionTypesFromBody(await readJson(await get(`${base}/condition-types`, signal)));
		},
		async simulate(input, signal) {
			const response = await adminFetch(`${base}/simulate`, {
				method: 'POST',
				signal,
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify(simulationBody(input))
			});
			return simulationFromBody(await readJson(response));
		}
	};
}
