/**
 * In-memory relationships for Storybook and tests: sample definitions and tuples, and a small
 * evaluator for a check that follows the declared paths only (`direct`, `union`, `intersection`,
 * `exclusion`, `tuple_to_userset`). Follows what the Admin API refuses: a tuple type that is not
 * a user, the members of a group or a declared object edge answers 400 (code AR050010), a tuple or
 * a definition that exists 409, a malformed expression 400, an unknown id 404.
 *
 * A user in `unknownMembershipUsers` has memberships the engine cannot read: a check that would
 * need them is denied with `resolved_via: 'unknown_membership'` (never "no groups").
 */
import { ApiError } from '../api-error';
import type {
	DefinitionChanges,
	DefinitionInput,
	DefinitionListQuery,
	EndUserRebacClient,
	ObjectTypeInfo,
	RebacCheckInput,
	RebacCheckResult,
	RebacTuple,
	RelationDefinition,
	TupleInput,
	TupleListQuery
} from '../end-user-rebac';

/** How deep an evaluation goes before it gives up (as unknown). */
const EVAL_DEPTH_LIMIT = 64;
const NOW = Date.UTC(2026, 10, 27, 3, 0, 0);
const DAY = 86_400_000;

export interface FakeRebacOptions {
	definitions?: RelationDefinition[];
	tuples?: RebacTuple[];
	delay?: number;
	/** Fail a call: a status. Keys: `listTuples`, `createTuple`, `removeTuple`, `listDefinitions`,
	 * `getDefinition`, `createDefinition`, `updateDefinition`, `removeDefinition`, `objectTypes`,
	 * `check`. */
	failOn?: Partial<Record<string, 400 | 403 | 404 | 500>>;
	/** The tuple list says it left the members-of-group tuples out. */
	usersetOmitted?: boolean;
	/** The tuple list says it left out what is reached through computed relations. */
	computedOmitted?: boolean;
	/** Members of groups, by group id (default: the sample engineering group). */
	groupMembers?: Record<string, string[]>;
	/** Users whose group memberships cannot be read (default: `usr_unknown`). */
	unknownMembershipUsers?: string[];
	/** The check answers a `debug` object too. */
	withDebug?: boolean;
}

export const definition = (
	id: string,
	object_type: string,
	relation_name: string,
	expression: unknown,
	extra: Partial<RelationDefinition> = {}
): RelationDefinition => ({
	id,
	object_type,
	relation_name,
	expression,
	description: null,
	priority: 0,
	active: true,
	unusable: false,
	created_at: NOW - 30 * DAY,
	updated_at: NOW - 30 * DAY,
	...extra
});

export const tuple = (
	id: string,
	relation: string,
	from: { type: string; id: string; relation?: string },
	to: { type: string; id: string },
	extra: Partial<RebacTuple> = {}
): RebacTuple => ({
	id,
	relation,
	from_type: from.type,
	from_id: from.id,
	from_relation: from.relation ?? null,
	to_type: to.type,
	to_id: to.id,
	expires_at: null,
	created_at: NOW - 10 * DAY,
	...extra
});

const direct = (relation: string) => ({ type: 'direct', relation });

export function sampleDefinitions(): RelationDefinition[] {
	return [
		definition('rd_doc_owner', 'document', 'owner', direct('owner'), {
			description: 'Whoever owns the document.'
		}),
		definition(
			'rd_doc_editor',
			'document',
			'editor',
			{ type: 'union', children: [direct('editor'), direct('owner')] },
			{ priority: 10 }
		),
		definition(
			'rd_doc_viewer',
			'document',
			'viewer',
			{
				type: 'union',
				children: [
					direct('viewer'),
					direct('editor'),
					{
						type: 'tuple_to_userset',
						tupleset: { relation: 'parent' },
						computed_userset: { relation: 'viewer' }
					}
				]
			},
			{
				description: 'Viewers, editors, and viewers of the folder the document is in.',
				priority: 20
			}
		),
		definition('rd_doc_download', 'document', 'can_download', {
			type: 'exclusion',
			base: direct('viewer'),
			subtract: direct('blocked')
		}),
		definition('rd_folder_viewer', 'folder', 'viewer', {
			type: 'union',
			children: [direct('viewer'), direct('owner')]
		}),
		definition('rd_folder_owner', 'folder', 'owner', direct('owner'))
	];
}

export function sampleTuples(): RebacTuple[] {
	return [
		tuple('rt_1', 'owner', { type: 'subject', id: 'usr_aiko' }, { type: 'document', id: 'doc_1' }),
		tuple(
			'rt_2',
			'viewer',
			{ type: 'group', id: 'grp_eng', relation: 'member' },
			{ type: 'folder', id: 'folder_a' }
		),
		// The child points at its parent: document#parent → folder.
		tuple('rt_3', 'parent', { type: 'document', id: 'doc_1' }, { type: 'folder', id: 'folder_a' }),
		tuple(
			'rt_4',
			'viewer',
			{ type: 'subject', id: 'usr_ben' },
			{ type: 'document', id: 'doc_2' },
			{ expires_at: NOW + 14 * DAY }
		),
		tuple('rt_5', 'blocked', { type: 'subject', id: 'usr_chen' }, { type: 'document', id: 'doc_1' })
	];
}

const failure = (status: number) => new ApiError(status, '', `Fake failure ${status}`);
const notFound = () => new ApiError(404, 'not_found', 'Not found', { error: 'not_found' });
const invalid = (message: string) =>
	new ApiError(400, 'invalid_request', message, {
		error: 'invalid_request',
		error_description: message
	});
const conflict = (message: string) =>
	new ApiError(409, 'conflict', message, { error: 'conflict', error_description: message });

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/** The API's refusal of an expression it cannot evaluate, or null. */
export function expressionProblem(value: unknown, path = 'definition'): string | null {
	if (!isRow(value) || typeof value.type !== 'string')
		return `${path} must be an object with a type`;
	switch (value.type) {
		case 'direct':
			return typeof value.relation === 'string' && value.relation
				? null
				: `${path}.relation is required`;
		case 'union':
		case 'intersection': {
			if (!Array.isArray(value.children) || value.children.length === 0)
				return `${path}.children must list at least one expression`;
			for (const [index, child] of value.children.entries()) {
				const problem = expressionProblem(child, `${path}.children[${index}]`);
				if (problem) return problem;
			}
			return null;
		}
		case 'exclusion':
			return (
				expressionProblem(value.base, `${path}.base`) ??
				expressionProblem(value.subtract, `${path}.subtract`)
			);
		case 'tuple_to_userset': {
			const tupleset = isRow(value.tupleset) ? value.tupleset.relation : null;
			const computed = isRow(value.computed_userset) ? value.computed_userset.relation : null;
			return typeof tupleset === 'string' && tupleset && typeof computed === 'string' && computed
				? null
				: `${path} needs tupleset.relation and computed_userset.relation`;
		}
		default:
			return `${path}.type "${value.type}" is not supported`;
	}
}

/** What the API accepts of one expression: distinct direct-leaf relations and nesting depth. */
export const MAX_DIRECT_RELATIONS = 80;
export const MAX_EXPRESSION_DEPTH = 32;

/** The API's refusal for an expression that is too wide or too deep, or null. */
export function expressionLimitProblem(value: unknown): string | null {
	const relations = new Set<string>();
	let deepest = 0;
	const walk = (node: unknown, depth: number) => {
		if (!isRow(node)) return;
		deepest = Math.max(deepest, depth);
		if (node.type === 'direct' && typeof node.relation === 'string') relations.add(node.relation);
		if (Array.isArray(node.children)) for (const child of node.children) walk(child, depth + 1);
		if (node.type === 'exclusion') {
			walk(node.base, depth + 1);
			walk(node.subtract, depth + 1);
		}
	};
	// The root is level 0: 32 unions around a leaf pass, 33 do not.
	walk(value, 0);
	if (deepest > MAX_EXPRESSION_DEPTH)
		return `definition is nested deeper than ${MAX_EXPRESSION_DEPTH} levels`;
	if (relations.size > MAX_DIRECT_RELATIONS)
		return `definition names more than ${MAX_DIRECT_RELATIONS} distinct relations`;
	return null;
}

export function createFakeRebac(options: FakeRebacOptions = {}): EndUserRebacClient {
	const definitions = structuredClone(options.definitions ?? sampleDefinitions());
	const tuples = structuredClone(options.tuples ?? sampleTuples());
	const groupMembers = options.groupMembers ?? { grp_eng: ['usr_aiko', 'usr_ben'] };
	const unknownUsers = options.unknownMembershipUsers ?? ['usr_unknown'];
	let serial = 0;

	async function call<T>(name: string, run: () => T): Promise<T> {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		const status = options.failOn?.[name];
		if (status) throw failure(status);
		return run();
	}

	const page = <T>(all: T[], query: { page?: number; limit?: number }) => {
		const limit = query.limit ?? 50;
		const at = query.page ?? 1;
		return {
			items: structuredClone(all.slice((at - 1) * limit, at * limit)),
			page: at,
			limit,
			total: all.length,
			hasNext: at * limit < all.length
		};
	};

	/**
	 * Whether the definitions of `fromType` walk through `relation` as the start of a
	 * tuple_to_userset path: an object edge is checked against the definition of its source (the
	 * child), whose tupleset relation points at the parent.
	 */
	const declaredEdge = (fromType: string, relation: string): boolean => {
		const uses = (value: unknown): boolean => {
			if (!isRow(value)) return false;
			if (value.type === 'tuple_to_userset')
				return isRow(value.tupleset) && value.tupleset.relation === relation;
			if (Array.isArray(value.children)) return value.children.some(uses);
			return uses(value.base) || uses(value.subtract);
		};
		// Only an active definition that can be read declares an edge, as on the server.
		return definitions.some(
			(entry) =>
				entry.object_type === fromType && entry.active && !entry.unusable && uses(entry.expression)
		);
	};

	function evaluate(input: RebacCheckInput): RebacCheckResult {
		const path: string[] = [];
		const live = (entry: RebacTuple) => entry.expires_at === null || entry.expires_at > NOW;
		/** Every branch is three-valued: a membership that cannot be read is neither yes nor no. */
		type Verdict = 'allow' | 'deny' | 'unknown';

		const holds = (
			expression: unknown,
			type: string,
			id: string,
			relation: string,
			depth: number
		): Verdict => {
			// Too deep: the answer cannot be told, so it is unknown, never “no”.
			if (depth > EVAL_DEPTH_LIMIT) return 'unknown';
			if (!isRow(expression)) return 'deny';
			switch (expression.type) {
				case 'direct': {
					let verdict: Verdict = 'deny';
					for (const entry of tuples) {
						if (
							!live(entry) ||
							entry.relation !== expression.relation ||
							entry.to_type !== type ||
							entry.to_id !== id
						)
							continue;
						if (entry.from_type === 'subject' || entry.from_type === 'user') {
							if (entry.from_id !== input.user_id) continue;
							path.push(`${type}:${id}#${String(expression.relation)} ← ${input.user_id}`);
							return 'allow';
						}
						if (entry.from_type === 'group' && entry.from_relation === 'member') {
							if (unknownUsers.includes(input.user_id)) {
								verdict = 'unknown';
								continue;
							}
							if ((groupMembers[entry.from_id] ?? []).includes(input.user_id)) {
								path.push(
									`${type}:${id}#${String(expression.relation)} ← group:${entry.from_id}#member`
								);
								return 'allow';
							}
						}
					}
					return verdict;
				}
				case 'union': {
					const verdicts = (expression.children as unknown[]).map((child) =>
						holds(child, type, id, relation, depth + 1)
					);
					if (verdicts.includes('allow')) return 'allow';
					return verdicts.includes('unknown') ? 'unknown' : 'deny';
				}
				case 'intersection': {
					const verdicts = (expression.children as unknown[]).map((child) =>
						holds(child, type, id, relation, depth + 1)
					);
					if (verdicts.includes('deny')) return 'deny';
					return verdicts.includes('unknown') ? 'unknown' : 'allow';
				}
				case 'exclusion': {
					const base = holds(expression.base, type, id, relation, depth + 1);
					if (base === 'deny') return 'deny';
					const subtract = holds(expression.subtract, type, id, relation, depth + 1);
					if (subtract === 'allow') return 'deny';
					// The subtraction cannot be told to be empty: never “subtract false”.
					if (subtract === 'unknown') return 'unknown';
					return base;
				}
				case 'tuple_to_userset': {
					const tupleset = (expression.tupleset as Row).relation;
					const computed = (expression.computed_userset as Row).relation as string;
					const verdicts = tuples
						.filter(
							(entry) =>
								live(entry) &&
								entry.relation === tupleset &&
								entry.from_type === type &&
								entry.from_id === id &&
								entry.from_type !== 'subject' &&
								entry.from_type !== 'user' &&
								entry.from_type !== 'group'
						)
						.map((edge) => relationHolds(edge.to_type, edge.to_id, computed, depth + 1));
					if (verdicts.includes('allow')) return 'allow';
					return verdicts.includes('unknown') ? 'unknown' : 'deny';
				}
				default:
					return 'deny';
			}
		};

		/** The relations being evaluated on the way down: reaching one again is a cycle. */
		const walking: string[] = [];
		const relationHolds = (type: string, id: string, relation: string, depth: number): Verdict => {
			const key = `${type}:${id}#${relation}`;
			if (walking.includes(key)) return 'unknown';
			walking.push(key);
			try {
				return relationOnce(type, id, relation, depth);
			} finally {
				walking.pop();
			}
		};
		const relationOnce = (type: string, id: string, relation: string, depth: number): Verdict => {
			const stored = definitions.find(
				(entry) => entry.object_type === type && entry.relation_name === relation
			);
			// Only an ACTIVE definition that cannot be read counts as unusable (an inactive one is
			// ignored). The checked relation itself denies, with no fallback to its own tuples;
			// reached through another expression it is unknown, so the parent cannot rely on “no”.
			if (stored?.active && stored.unusable) return depth > 0 ? 'unknown' : 'deny';
			const defined = stored?.active ? stored : undefined;
			return holds(defined ? defined.expression : direct(relation), type, id, relation, depth);
		};

		const verdict = relationHolds(input.object_type, input.object_id, input.relation, 0);
		const allowed = verdict === 'allow';
		const computed = definitions.some(
			(entry) =>
				entry.active &&
				entry.object_type === input.object_type &&
				entry.relation_name === input.relation
		);
		return {
			allowed,
			resolved_via: allowed
				? computed
					? 'computed'
					: 'direct'
				: verdict === 'unknown'
					? 'unknown_membership'
					: null,
			path: allowed ? path.slice(0, 3) : [],
			debug: options.withDebug
				? { evaluated_tuples: tuples.length, depth_limit: EVAL_DEPTH_LIMIT }
				: null
		};
	}

	return {
		listTuples: (query: TupleListQuery = {}) =>
			call('listTuples', () => {
				const matching = tuples
					.filter((entry) => !query.object_type || entry.to_type === query.object_type)
					.filter((entry) => !query.relation || entry.relation === query.relation)
					.filter((entry) => !query.subject_id || entry.from_id === query.subject_id);
				return {
					...page(matching, query),
					usersetOmitted: options.usersetOmitted === true,
					computedOmitted: options.computedOmitted === true
				};
			}),
		createTuple: (input: TupleInput) =>
			call('createTuple', () => {
				const fromType = input.from_type === 'user' ? 'subject' : input.from_type;
				const allowedSource =
					fromType === 'subject' ||
					(fromType === 'group' && input.from_relation === 'member') ||
					(fromType !== 'group' && declaredEdge(fromType, input.relation));
				if (!allowedSource)
					throw new ApiError(
						400,
						'invalid_request',
						'This relationship tuple type is not allowed',
						{
							error: 'invalid_request',
							error_description: 'This relationship tuple type is not allowed',
							error_code: 'AR050010'
						}
					);
				if (!input.relation || !input.from_id || !input.to_type || !input.to_id)
					throw invalid('relationship_type, from_id, to_type and to_id are required');
				if (
					tuples.some(
						(entry) =>
							entry.relation === input.relation &&
							entry.from_type === fromType &&
							entry.from_id === input.from_id &&
							entry.from_relation === (input.from_relation ?? null) &&
							entry.to_type === input.to_type &&
							entry.to_id === input.to_id
					)
				)
					throw conflict('The tuple already exists');
				const created = tuple(
					`rt_new_${++serial}`,
					input.relation,
					{ type: fromType, id: input.from_id, relation: input.from_relation ?? undefined },
					{ type: input.to_type, id: input.to_id },
					{ expires_at: input.expires_at ?? null, created_at: NOW }
				);
				tuples.unshift(created);
				return structuredClone(created);
			}),
		removeTuple: (tupleId) =>
			call('removeTuple', () => {
				const at = tuples.findIndex((entry) => entry.id === tupleId);
				if (at < 0) throw notFound();
				tuples.splice(at, 1);
			}),
		listDefinitions: (query: DefinitionListQuery = {}) =>
			call('listDefinitions', () => {
				const search = query.search?.toLowerCase();
				const matching = definitions
					.filter((entry) => !query.object_type || entry.object_type === query.object_type)
					.filter((entry) => query.active === undefined || entry.active === query.active)
					.filter(
						(entry) =>
							!search ||
							entry.relation_name.toLowerCase().includes(search) ||
							entry.object_type.toLowerCase().includes(search) ||
							(entry.description ?? '').toLowerCase().includes(search)
					)
					.sort(
						(a, b) =>
							a.object_type.localeCompare(b.object_type) ||
							b.priority - a.priority ||
							a.relation_name.localeCompare(b.relation_name)
					);
				return page(matching, query);
			}),
		getDefinition: (definitionId) =>
			call('getDefinition', () => {
				const found = definitions.find((entry) => entry.id === definitionId);
				if (!found) throw notFound();
				return structuredClone(found);
			}),
		createDefinition: (input: DefinitionInput) =>
			call('createDefinition', () => {
				if (!input.object_type || !input.relation_name)
					throw invalid('object_type, relation_name, definition are required');
				const problem =
					expressionProblem(input.expression) ?? expressionLimitProblem(input.expression);
				if (problem) throw invalid(problem);
				if (
					definitions.some(
						(entry) =>
							entry.object_type === input.object_type && entry.relation_name === input.relation_name
					)
				)
					throw conflict('The relation is already defined on this object type');
				const created = definition(
					`rd_new_${++serial}`,
					input.object_type,
					input.relation_name,
					structuredClone(input.expression),
					{
						description: input.description || null,
						priority: input.priority,
						active: input.active,
						created_at: NOW,
						updated_at: NOW
					}
				);
				definitions.push(created);
				return structuredClone(created);
			}),
		updateDefinition: (definitionId, changes: DefinitionChanges) =>
			call('updateDefinition', () => {
				const found = definitions.find((entry) => entry.id === definitionId);
				if (!found) throw notFound();
				if (changes.expression !== undefined) {
					const problem =
						expressionProblem(changes.expression) ?? expressionLimitProblem(changes.expression);
					if (problem) throw invalid(problem);
					found.expression = structuredClone(changes.expression);
					found.unusable = false;
				}
				if (changes.description !== undefined) found.description = changes.description || null;
				if (changes.priority !== undefined) found.priority = changes.priority;
				if (changes.active !== undefined) found.active = changes.active;
				found.updated_at = NOW;
			}),
		removeDefinition: (definitionId) =>
			call('removeDefinition', () => {
				const at = definitions.findIndex((entry) => entry.id === definitionId);
				if (at < 0) throw notFound();
				definitions.splice(at, 1);
			}),
		objectTypes: () =>
			call('objectTypes', (): ObjectTypeInfo[] => {
				const counts = new Map<string, number>();
				for (const entry of definitions)
					counts.set(entry.object_type, (counts.get(entry.object_type) ?? 0) + 1);
				return [...counts.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, definition_count]) => ({ name, definition_count }));
			}),
		check: (input) =>
			call('check', () => {
				if (!input.user_id || !input.relation || !input.object_id)
					throw invalid('user_id, relation, object are required');
				return evaluate(input);
			})
	};
}
