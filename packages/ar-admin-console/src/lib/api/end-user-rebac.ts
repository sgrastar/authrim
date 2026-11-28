/**
 * The tenant's relationships (`/api/admin/rebac`): relation definitions (how a relation on an
 * object type is computed), relationship tuples (who has which relation on which object) and a
 * check that asks the engine one question. Reading needs `admin:roles:read`; creating, changing
 * and checking `admin:roles:write`, deleting `admin:roles:delete`, and changes also take a tenant
 * administrator. Relationships only count while "Relationships" is on in Settings → Authorization.
 *
 * A tuple's subject is a user (`from_type` `subject`), the members of a group (`from_type`
 * `group`, `from_relation` `member`) or an object that a `tuple_to_userset` path walks through.
 * Listing tuples leaves out members-of-group subjects when the API says so
 * (`userset_subjects_omitted`); a check follows the declared paths only. Times are milliseconds.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { stepUpHeaders, withStepUp } from './admin-step-up';
import { errorFromResponse } from './api-error';
import { MalformedResponseError, msOrNull, type Paged } from './end-user-groups';

export interface RebacTuple {
	id: string;
	/** The relation (`relationship_type` on the wire). */
	relation: string;
	/** `subject` (a user; `user` is read the same), `group`, or an object type. */
	from_type: string;
	from_id: string;
	/** `member` on a group: every member of the group. Null on any other tuple. */
	from_relation: string | null;
	to_type: string;
	to_id: string;
	/** UNIX milliseconds; null: never; 0 is an expiry at the epoch (long passed). */
	expires_at: number | null;
	created_at: number | null;
	/**
	 * A group tuple stored before members-of-group tuples were told apart (no `from_relation`):
	 * the API does not evaluate it until it is created again. Absent unless the API says so.
	 */
	inactiveLegacy?: boolean;
}

export interface TupleListQuery {
	/** The object's type (`to_type`). */
	object_type?: string;
	relation?: string;
	/** The subject's id (`from_id`). */
	subject_id?: string;
	page?: number;
	limit?: number;
}

export interface TupleList extends Paged<RebacTuple> {
	/** The API left out the members-of-group tuples (its list operations do not expand them). */
	usersetOmitted: boolean;
	/** The API left out what is only reachable through computed relations (`computed_relations_omitted`). */
	computedOmitted: boolean;
}

export interface TupleInput {
	relation: string;
	from_type: string;
	from_id: string;
	from_relation?: string | null;
	to_type: string;
	to_id: string;
	/** UNIX milliseconds; null or left out: never. */
	expires_at?: number | null;
}

export interface RelationDefinition {
	id: string;
	object_type: string;
	relation_name: string;
	/** The stored expression as the API sent it (the editor reads it; see rebac-model). */
	expression: unknown;
	description: string | null;
	priority: number;
	active: boolean;
	/** The API could not read the stored expression: the relation is not evaluated. */
	unusable: boolean;
	created_at: number | null;
	updated_at: number | null;
}

export interface DefinitionInput {
	object_type: string;
	relation_name: string;
	expression: unknown;
	description: string;
	priority: number;
	active: boolean;
}

/** What can change on a definition: not the object type or the relation's name. */
export type DefinitionChanges = Partial<Omit<DefinitionInput, 'object_type' | 'relation_name'>>;

export interface DefinitionListQuery {
	object_type?: string;
	search?: string;
	active?: boolean;
	page?: number;
	limit?: number;
}

export interface ObjectTypeInfo {
	name: string;
	definition_count: number;
}

export interface RebacCheckInput {
	user_id: string;
	relation: string;
	object_type: string;
	object_id: string;
}

export interface RebacCheckResult {
	allowed: boolean;
	/** `direct`, `computed`, `context`, `cache`, `closure`, `unknown_membership`… as sent; null: none. */
	resolved_via: string | null;
	path: string[];
	/** What the API returned beyond the verdict, when it did. */
	debug: Record<string, unknown> | null;
}

export interface EndUserRebacClient {
	listTuples(query?: TupleListQuery, signal?: AbortSignal): Promise<TupleList>;
	/** A tuple type the API does not take answers 400; one that exists 409. */
	createTuple(input: TupleInput): Promise<RebacTuple>;
	removeTuple(tupleId: string): Promise<void>;
	listDefinitions(
		query?: DefinitionListQuery,
		signal?: AbortSignal
	): Promise<Paged<RelationDefinition>>;
	getDefinition(definitionId: string, signal?: AbortSignal): Promise<RelationDefinition>;
	/** A malformed expression answers 400; a relation already defined on the type 409. */
	createDefinition(input: DefinitionInput): Promise<RelationDefinition>;
	updateDefinition(definitionId: string, changes: DefinitionChanges): Promise<void>;
	removeDefinition(definitionId: string): Promise<void>;
	objectTypes(signal?: AbortSignal): Promise<ObjectTypeInfo[]>;
	check(input: RebacCheckInput, signal?: AbortSignal): Promise<RebacCheckResult>;
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const whole = (value: unknown, fallback: number): number => {
	const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
};

/** An expiry in milliseconds; 0 is a real (already passed) expiry, not “none”. */
const expiryOrNull = (value: unknown): number | null =>
	value === 0 || value === '0' ? 0 : msOrNull(value);

export function tupleFromRow(value: unknown): RebacTuple {
	const row = record(value);
	return {
		id: text(row.id),
		relation: text(row.relationship_type) || text(row.relation),
		from_type: text(row.from_type),
		from_id: text(row.from_id),
		from_relation: text(row.from_relation) || null,
		to_type: text(row.to_type),
		to_id: text(row.to_id),
		expires_at: expiryOrNull(row.expires_at),
		created_at: msOrNull(row.created_at),
		...(row.inactive_legacy === true ? { inactiveLegacy: true } : {})
	};
}

export function definitionFromRow(value: unknown): RelationDefinition {
	const row = record(value);
	return {
		id: text(row.id),
		object_type: text(row.object_type),
		relation_name: text(row.relation_name),
		expression: row.definition ?? null,
		description: text(row.description) || null,
		priority: whole(row.priority, 0),
		active: row.is_active !== false && row.is_active !== 0,
		unusable: row.unusable === true,
		created_at: msOrNull(row.created_at),
		updated_at: msOrNull(row.updated_at)
	};
}

export function objectTypesFromBody(body: Row): ObjectTypeInfo[] {
	return rows(body.object_types)
		.map((item) => {
			const row = record(item);
			return { name: text(row.name), definition_count: whole(row.definition_count, 0) };
		})
		.filter((entry) => entry.name !== '');
}

export function checkFromBody(body: Row): RebacCheckResult {
	if (typeof body.allowed !== 'boolean') throw new MalformedResponseError('allowed is missing');
	const debug = record(body.debug);
	return {
		allowed: body.allowed,
		resolved_via: text(body.resolved_via) || null,
		path: rows(body.path).filter((item): item is string => typeof item === 'string'),
		debug: Object.keys(debug).length > 0 ? debug : null
	};
}

/** The request body of a tuple create. */
export function tupleBody(input: TupleInput): Record<string, unknown> {
	return {
		relationship_type: input.relation.trim(),
		from_type: input.from_type,
		from_id: input.from_id.trim(),
		...(input.from_relation ? { from_relation: input.from_relation } : {}),
		to_type: input.to_type.trim(),
		to_id: input.to_id.trim(),
		// 0 is sent: it is an expiry in the past, not “no expiry” (only null or none is left out).
		...(input.expires_at !== null && input.expires_at !== undefined
			? { expires_at: input.expires_at }
			: {})
	};
}

/** The request body of a definition create or update: what is given, trimmed. */
export function definitionBody(input: Partial<DefinitionInput>): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (input.object_type !== undefined) body.object_type = input.object_type.trim();
	if (input.relation_name !== undefined) body.relation_name = input.relation_name.trim();
	if (input.expression !== undefined) body.definition = input.expression;
	if (input.description !== undefined) body.description = input.description.trim();
	if (input.priority !== undefined) body.priority = input.priority;
	if (input.active !== undefined) body.is_active = input.active;
	return body;
}

export function checkBody(input: RebacCheckInput): Record<string, unknown> {
	return {
		// The stored ID as it is (`subject_id`): the older `user_id` has one `user:` prefix stripped.
		subject_id: input.user_id.trim(),
		relation: input.relation.trim(),
		object: input.object_id.trim(),
		object_type: input.object_type.trim()
	};
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

function paged<T>(body: Row, key: string, map: (value: unknown) => T): Paged<T> {
	const pagination = record(body.pagination);
	const items = rows(body[key]).map(map);
	const page = whole(pagination.page, 1);
	const total = whole(pagination.total, items.length);
	const limit = whole(pagination.limit, items.length);
	return { items, page, limit, total, hasNext: page * limit < total };
}

export function httpEndUserRebac(tenantId: string): EndUserRebacClient {
	const base = `${API_BASE_URL}/api/admin/rebac`;
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
	const definitionUrl = (id: string) => `${base}/relation-definitions/${encodeURIComponent(id)}`;
	return {
		async listTuples(query = {}, signal) {
			const params = new URLSearchParams();
			if (query.object_type) params.set('to_type', query.object_type);
			if (query.relation) params.set('relationship_type', query.relation);
			if (query.subject_id) params.set('from_id', query.subject_id);
			if (query.page) params.set('page', String(query.page));
			if (query.limit) params.set('limit', String(query.limit));
			const search = params.toString();
			const body = await readJson(await get(`${base}/tuples${search ? `?${search}` : ''}`, signal));
			return {
				...paged(body, 'tuples', tupleFromRow),
				usersetOmitted: body.userset_subjects_omitted === true,
				computedOmitted: body.computed_relations_omitted === true
			};
		},
		async createTuple(input) {
			const body = await write(`${base}/tuples`, 'POST', tupleBody(input));
			const created = tupleFromRow(body.tuple);
			if (!created.id) throw new MalformedResponseError('tuple is missing');
			return created;
		},
		async removeTuple(tupleId) {
			await write(`${base}/tuples/${encodeURIComponent(tupleId)}`, 'DELETE');
		},
		async listDefinitions(query = {}, signal) {
			const params = new URLSearchParams();
			if (query.object_type) params.set('object_type', query.object_type);
			if (query.search) params.set('search', query.search);
			if (query.active !== undefined) params.set('is_active', String(query.active));
			if (query.page) params.set('page', String(query.page));
			if (query.limit) params.set('limit', String(query.limit));
			const search = params.toString();
			const body = await readJson(
				await get(`${base}/relation-definitions${search ? `?${search}` : ''}`, signal)
			);
			return paged(body, 'definitions', definitionFromRow);
		},
		async getDefinition(definitionId, signal) {
			const body = await readJson(await get(definitionUrl(definitionId), signal));
			return definitionFromRow(body.definition ?? body);
		},
		async createDefinition(input) {
			const body = await write(`${base}/relation-definitions`, 'POST', definitionBody(input));
			const created = definitionFromRow(body.definition);
			if (!created.id) throw new MalformedResponseError('definition is missing');
			return created;
		},
		async updateDefinition(definitionId, changes) {
			await write(definitionUrl(definitionId), 'PUT', definitionBody(changes));
		},
		async removeDefinition(definitionId) {
			await write(definitionUrl(definitionId), 'DELETE');
		},
		async objectTypes(signal) {
			return objectTypesFromBody(await readJson(await get(`${base}/object-types`, signal)));
		},
		async check(input, signal) {
			const response = await adminFetch(`${base}/check`, {
				method: 'POST',
				signal,
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify(checkBody(input))
			});
			return checkFromBody(await readJson(response));
		}
	};
}
