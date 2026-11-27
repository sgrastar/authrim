/**
 * In-memory policy rules for Storybook and tests, with the API's condition vocabulary
 * (including the group conditions) and a small evaluator for a simulation. Follows what the
 * Admin API refuses: a rule without a name, an effect that is not allow or deny, a condition
 * whose type is not listed, or a required parameter missing answers 400; an unknown rule 404.
 *
 * The evaluator mirrors the real engine where it matters here. It knows the group conditions,
 * `has_role`, `has_any_role`, `has_all_roles`, `is_resource_owner` and `attribute_equals`; any other condition is
 * not met (never "met by default"). Groups the simulation does not give are "resolved" from a
 * small table, as the server reads memberships, and `details.subject_groups` says which way
 * they were found: `given`, `resolved` or `unknown`. While they are unknown and any enabled rule
 * uses a group condition, nothing is granted from the rules at all (the server refuses to
 * decide on rules it cannot evaluate): allowed is false, whatever the rules say, and no policy
 * is named.
 */
import { ApiError } from '../api-error';
import type {
	ConditionTypeInfo,
	ConditionTypes,
	EndUserPoliciesClient,
	PolicyCondition,
	PolicyListQuery,
	PolicyRule,
	PolicySimulation,
	PolicySimulationInput
} from '../end-user-policies';

const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const DAY = 86_400_000;

export interface FakePoliciesOptions {
	rules?: PolicyRule[];
	delay?: number;
	/** Fail a call: a status. Keys: `list`, `get`, `create`, `update`, `remove`, `types`, `simulate`. */
	failOn?: Partial<Record<string, 400 | 403 | 404 | 500>>;
	/** Leave the group conditions out, as an API without them answers. */
	withoutGroupConditions?: boolean;
	/** Add a condition type the editor cannot draw (a parameter of an unknown type). */
	withOddCondition?: boolean;
	/** The tenant's dynamic groups (default: the sample Japan office). */
	dynamicGroupIds?: string[];
	/**
	 * Role names granted to groups, by group id (default: `japan_staff` to the sample Japan
	 * office). The roles of a dynamic group, or of an ancestor of one, are granted through a
	 * service group: a deny rule may not name them.
	 */
	groupRoles?: Record<string, string[]>;
	/** Child groups by parent id: a group with a dynamic descendant counts as dynamic too. */
	groupChildren?: Record<string, string[]>;
}

/** The groups the fake server finds for a user (by the sample groups' ids). */
const RESOLVED_GROUPS: Readonly<Record<string, string[]>> = {
	usr_aiko: ['grp_jp', 'grp_eng'],
	usr_ben: ['grp_eng', 'grp_backend'],
	usr_chen: ['grp_backend']
};

const param = (
	name: string,
	type: string,
	label: string,
	required = true
): ConditionTypeInfo['params'][number] => ({ name, type, label, required });

const SCOPE = [
	param('scope', 'string', 'Scope (global, group or resource)', false),
	param('scopeTarget', 'string', 'Scope Target (e.g. group:grp_123)', false)
];

export function sampleConditionTypes(options: FakePoliciesOptions = {}): ConditionTypes {
	const types: ConditionTypeInfo[] = [
		{
			type: 'has_role',
			category: 'rbac',
			label: 'Has Role',
			description: 'Subject has a specific role',
			params: [param('role', 'string', 'Role Name'), ...SCOPE]
		},
		{
			type: 'has_any_role',
			category: 'rbac',
			label: 'Has Any Role',
			description: 'Subject has any of the specified roles',
			params: [param('roles', 'string[]', 'Role Names'), ...SCOPE]
		},
		{
			type: 'has_all_roles',
			category: 'rbac',
			label: 'Has All Roles',
			description: 'Subject has all specified roles',
			params: [param('roles', 'string[]', 'Role Names'), ...SCOPE]
		},
		{
			type: 'is_resource_owner',
			category: 'ownership',
			label: 'Is Resource Owner',
			description: 'Subject owns the resource (from the check’s resource context)',
			params: []
		},
		...(options.withoutGroupConditions
			? []
			: [
					{
						type: 'in_group',
						category: 'group',
						label: 'In Group',
						description: 'Subject is in the group (or a group below it)',
						params: [param('group_id', 'string', 'Group')]
					},
					{
						type: 'in_any_group',
						category: 'group',
						label: 'In Any Group',
						description: 'Subject is in at least one of the groups',
						params: [param('group_ids', 'string[]', 'Groups')]
					},
					{
						type: 'in_all_groups',
						category: 'group',
						label: 'In All Groups',
						description: 'Subject is in every one of the groups',
						params: [param('group_ids', 'string[]', 'Groups')]
					},
					{
						type: 'not_in_any_group',
						category: 'group',
						label: 'Not In Any Group',
						description: 'Subject is in none of the groups (refused while membership is unknown)',
						params: [param('group_ids', 'string[]', 'Groups')]
					},
					{
						type: 'same_group',
						category: 'group',
						label: 'Same Group As Resource',
						description: 'Subject and the resource share a group',
						params: []
					}
				]),
		{
			type: 'attribute_equals',
			category: 'abac',
			label: 'Attribute Equals',
			description: 'Subject attribute equals a specific value',
			params: [
				param('name', 'string', 'Attribute Name'),
				param('value', 'string', 'Expected Value')
			]
		},
		{
			type: 'time_in_range',
			category: 'time',
			label: 'Time In Range',
			description: 'Current time is within a specific hour range',
			params: [
				param('startHour', 'number', 'Start Hour (0-23)'),
				param('endHour', 'number', 'End Hour (0-24)'),
				param('timezone', 'string', 'Timezone (IANA)', false)
			]
		},
		{
			type: 'day_of_week',
			category: 'time',
			label: 'Day of Week',
			description: 'Current day matches allowed days',
			params: [
				param('allowedDays', 'number[]', 'Allowed Days (0=Sun, 6=Sat)'),
				param('timezone', 'string', 'Timezone (IANA)', false)
			]
		},
		{
			type: 'numeric_between',
			category: 'numeric',
			label: 'Between',
			description: 'Attribute value is between min and max',
			params: [
				param('name', 'string', 'Attribute Name'),
				param('min', 'number', 'Minimum'),
				param('max', 'number', 'Maximum')
			]
		},
		...(options.withOddCondition
			? [
					{
						type: 'ip_in_ranges',
						category: 'network',
						label: 'IP In Ranges',
						description: 'The request comes from one of the ranges',
						params: [param('ranges', 'object[]', 'Ranges')]
					}
				]
			: [])
	];
	return {
		types,
		categories: [
			{ id: 'rbac', label: 'Role-Based (RBAC)' },
			{ id: 'ownership', label: 'Ownership' },
			{ id: 'group', label: 'Group-Based' },
			{ id: 'abac', label: 'Attribute-Based (ABAC)' },
			{ id: 'time', label: 'Time-Based' },
			{ id: 'numeric', label: 'Numeric' },
			{ id: 'network', label: 'Network' }
		]
	};
}

const rule = (
	id: string,
	name: string,
	extra: Partial<PolicyRule> & Pick<PolicyRule, 'effect' | 'conditions'>
): PolicyRule => ({
	id,
	name,
	description: null,
	priority: 100,
	resource_types: [],
	actions: [],
	enabled: true,
	created_at: NOW - 30 * DAY,
	updated_at: NOW - 2 * DAY,
	...extra
});

export function samplePolicies(): PolicyRule[] {
	return [
		rule('pol_jp', 'Japan office reads documents', {
			description: 'Members of the Japan office may read documents.',
			effect: 'allow',
			priority: 200,
			resource_types: ['document'],
			actions: ['read'],
			conditions: [{ type: 'in_group', params: { group_id: 'grp_jp' } }]
		}),
		rule('pol_contractors', 'Contractors never delete', {
			effect: 'deny',
			priority: 300,
			actions: ['delete'],
			conditions: [
				{ type: 'in_any_group', params: { group_ids: ['grp_contractors', 'grp_sales'] } }
			]
		}),
		rule('pol_hours', 'Office hours', {
			description: 'Invoices are approved on weekdays, 9 to 18.',
			effect: 'allow',
			resource_types: ['invoice'],
			actions: ['approve'],
			conditions: [
				{ type: 'time_in_range', params: { startHour: 9, endHour: 18, timezone: 'Asia/Tokyo' } },
				{ type: 'day_of_week', params: { allowedDays: [1, 2, 3, 4, 5] } }
			]
		}),
		rule('pol_legacy', 'Legacy rule (off)', {
			effect: 'allow',
			enabled: false,
			priority: 10,
			resource_types: ['report'],
			conditions: []
		})
	];
}

const failure = (status: number) => new ApiError(status, '', `Fake failure ${status}`);
const notFound = () =>
	new ApiError(404, 'not_found', 'Policy rule not found', { error: 'not_found' });
const invalid = (message: string) =>
	new ApiError(400, 'invalid_request', message, {
		error: 'invalid_request',
		error_description: message
	});

export function createFakePolicies(options: FakePoliciesOptions = {}): EndUserPoliciesClient {
	const rules = structuredClone(options.rules ?? samplePolicies());
	const catalog = sampleConditionTypes(options);
	let serial = rules.length;

	async function call<T>(name: string, run: () => T): Promise<T> {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		const status = options.failOn?.[name];
		if (status) throw failure(status);
		return run();
	}

	const dynamicIds = options.dynamicGroupIds ?? ['grp_jp'];
	/** A dynamic group, or one with a dynamic group somewhere below it. */
	const touchesDynamic = (id: string, seen: string[] = []): boolean =>
		dynamicIds.includes(id) ||
		(!seen.includes(id) &&
			(options.groupChildren?.[id] ?? []).some((child) => touchesDynamic(child, [...seen, id])));

	/** Roles granted through a dynamic group or an ancestor of one (a member gets them). */
	const decidedRoles = new Set(
		Object.entries(options.groupRoles ?? { grp_jp: ['japan_staff'] })
			.filter(([groupId]) => touchesDynamic(groupId))
			.flatMap(([, names]) => names)
	);

	/**
	 * Why a rule relies on non-membership of a dynamic group, or null (the engine's own words). A
	 * dynamic membership is only eventually consistent, so "not a member" may be stale: refused are
	 * `not_in_any_group` naming such a group (or one with dynamic descendants), and, in a deny
	 * rule, `in_group` / `in_any_group` / `in_all_groups` naming one, or `same_group` while the
	 * tenant has any dynamic group.
	 */
	function dynamicProblem(rule: {
		effect: 'allow' | 'deny';
		conditions: PolicyCondition[];
	}): string | null {
		for (const condition of rule.conditions) {
			const named = [condition.params.group_id, condition.params.group_ids]
				.flat()
				.filter((id): id is string => typeof id === 'string');
			const dynamic = named.find((id) => touchesDynamic(id));
			if (condition.type === 'not_in_any_group' && dynamic !== undefined)
				return `not_in_any_group names ${dynamic}, whose membership a service group decides`;
			if (rule.effect !== 'deny') continue;
			if (['has_role', 'has_any_role', 'has_all_roles'].includes(condition.type)) {
				const roles =
					condition.type === 'has_role' ? [condition.params.role] : [condition.params.roles].flat();
				const decidedRole = roles.find(
					(name): name is string => typeof name === 'string' && decidedRoles.has(name)
				);
				if (decidedRole !== undefined)
					return `A deny rule's ${condition.type} names ${decidedRole}, a role granted through a service group`;
			}
			if (condition.type === 'same_group' && dynamicIds.length > 0)
				return 'A deny rule compares with the resource groups (same_group) while service groups decide memberships';
			if (
				['in_group', 'in_any_group', 'in_all_groups'].includes(condition.type) &&
				dynamic !== undefined
			)
				return `A deny rule's ${condition.type} names ${dynamic}, whose membership a service group decides`;
		}
		return null;
	}

	/** The API's 400 for a rule that relies on non-membership of a dynamic group. */
	function validateDynamic(rule: { effect: 'allow' | 'deny'; conditions: PolicyCondition[] }) {
		const problem = dynamicProblem(rule);
		if (problem)
			throw new ApiError(400, 'dynamic_group_negative_condition', problem, {
				error: 'dynamic_group_negative_condition',
				error_description: problem
			});
	}

	/** What the Admin API's validation refuses, in its words. */
	function validate(conditions: PolicyCondition[]) {
		for (const [index, condition] of conditions.entries()) {
			const info = catalog.types.find((entry) => entry.type === condition.type);
			if (!info) throw invalid(`conditions[${index}].type is not a known condition type`);
			for (const spec of info.params) {
				const value = condition.params[spec.name];
				const missing =
					value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
				if (spec.required && missing)
					throw invalid(
						`conditions[${index}].params.${spec.name} is missing or not valid for ${condition.type}`
					);
			}
		}
	}

	const covers = (list: readonly string[], value: string) =>
		list.length === 0 || list.includes(value);

	const GROUP_TYPES = [
		'in_group',
		'in_any_group',
		'in_all_groups',
		'not_in_any_group',
		'same_group'
	];

	/** What a deny rule needs that the simulated check does not give, or null. */
	function missingTarget(entry: PolicyRule, input: PolicySimulationInput): string | null {
		for (const condition of entry.conditions) {
			if (condition.type === 'is_resource_owner' && !input.owner_id.trim())
				return 'the resource owner';
			if (condition.type === 'same_group' && input.resource_group_ids.length === 0)
				return "the resource's groups";
			if (['has_role', 'has_any_role', 'has_all_roles'].includes(condition.type)) {
				if (condition.params.scope === 'group' && input.resource_group_ids.length === 0)
					return "the resource's groups";
				if (condition.params.scope === 'resource' && !input.resource_id.trim())
					return 'the resource';
			}
		}
		return null;
	}

	function conditionHolds(
		condition: PolicyCondition,
		subject: {
			id: string;
			groups: string[];
			roles: string[];
			attributes: { name: string; value: string }[];
		},
		resource: { ownerId: string; groups: string[] }
	): boolean {
		const ids = (key: string) =>
			Array.isArray(condition.params[key]) ? (condition.params[key] as string[]) : [];
		const { groups } = subject;
		switch (condition.type) {
			case 'in_group':
				return groups.includes(String(condition.params.group_id));
			case 'in_any_group':
				return ids('group_ids').some((id) => groups.includes(id));
			case 'in_all_groups':
				return ids('group_ids').every((id) => groups.includes(id));
			case 'not_in_any_group':
				return !ids('group_ids').some((id) => groups.includes(id));
			case 'same_group':
				return resource.groups.some((id) => groups.includes(id));
			case 'has_role':
				return subject.roles.includes(String(condition.params.role));
			case 'has_any_role':
				return ids('roles').some((name) => subject.roles.includes(name));
			case 'has_all_roles': {
				const wanted = ids('roles');
				return wanted.length > 0 && wanted.every((name) => subject.roles.includes(name));
			}
			case 'is_resource_owner':
				return resource.ownerId !== '' && resource.ownerId === subject.id;
			case 'attribute_equals':
				return subject.attributes.some(
					(attribute) =>
						attribute.name === condition.params.name && attribute.value === condition.params.value
				);
			default:
				return false;
		}
	}

	return {
		list: (query: PolicyListQuery = {}) =>
			call('list', () => {
				const search = query.search?.toLowerCase();
				const matching = rules
					.filter((entry) => query.enabled === undefined || entry.enabled === query.enabled)
					.filter(
						(entry) =>
							!search ||
							entry.name.toLowerCase().includes(search) ||
							(entry.description ?? '').toLowerCase().includes(search)
					)
					.sort((a, b) => b.priority - a.priority);
				const limit = query.limit ?? 20;
				const page = query.page ?? 1;
				return {
					items: structuredClone(matching.slice((page - 1) * limit, page * limit)),
					page,
					limit,
					total: matching.length,
					hasNext: page * limit < matching.length
				};
			}),
		get: (ruleId) =>
			call('get', () => {
				const found = rules.find((entry) => entry.id === ruleId);
				if (!found) throw notFound();
				return structuredClone(found);
			}),
		create: (input) =>
			call('create', () => {
				if (!input.name.trim()) throw invalid('Name is required');
				validate(input.conditions);
				validateDynamic(input);
				const id = `pol_new_${++serial}`;
				rules.push({
					...structuredClone(input),
					description: input.description || null,
					id,
					created_at: NOW,
					updated_at: NOW
				});
				return { id };
			}),
		update: (ruleId, changes) =>
			call('update', () => {
				const found = rules.find((entry) => entry.id === ruleId);
				if (!found) throw notFound();
				if (changes.name !== undefined && !changes.name.trim()) throw invalid('Name is required');
				if (changes.conditions) validate(changes.conditions);
				// Switching a rule off always passes; any other change is judged on the rule as it
				// would become, whole (switching one on is not a way past the check).
				const keys = Object.keys(changes);
				const disableOnly = keys.length === 1 && keys[0] === 'enabled' && changes.enabled === false;
				if (!disableOnly) validateDynamic({ ...found, ...changes });
				const { description, ...rest } = structuredClone(changes);
				Object.assign(found, rest, {
					...(description !== undefined ? { description: description || null } : {}),
					updated_at: NOW
				});
			}),
		remove: (ruleId) =>
			call('remove', () => {
				const at = rules.findIndex((entry) => entry.id === ruleId);
				if (at < 0) throw notFound();
				rules.splice(at, 1);
			}),
		conditionTypes: () => call('types', () => structuredClone(catalog)),
		simulate: (input) =>
			call('simulate', (): PolicySimulation => {
				const resolved = RESOLVED_GROUPS[input.subject_id];
				const how = input.group_ids !== null ? 'given' : resolved ? 'resolved' : 'unknown';
				// Unknown memberships are not "no groups": every group condition is false.
				const groups = input.group_ids ?? resolved ?? [];
				const details = { subject_groups: how };
				const evaluated = rules
					.filter((entry) => entry.enabled)
					.sort((a, b) => b.priority - a.priority);
				if (
					how === 'unknown' &&
					evaluated.some((entry) =>
						entry.conditions.some((condition) => GROUP_TYPES.includes(condition.type))
					)
				)
					return {
						allowed: false,
						reason:
							"A rule uses group conditions, which need the subject's groups, and they are unknown",
						decided_by: null,
						details,
						evaluated_rules: evaluated.length
					};
				// Rules that rely on a dynamic group's non-membership make the rules unusable.
				for (const entry of evaluated) {
					const problem = dynamicProblem(entry);
					if (problem)
						return {
							allowed: false,
							reason: `Rule ${entry.id}: ${problem}`,
							decided_by: null,
							details,
							evaluated_rules: evaluated.length
						};
				}
				const subject = {
					id: input.subject_id,
					groups,
					roles: input.role_names,
					attributes: input.attributes
				};
				const resource = { ownerId: input.owner_id, groups: input.resource_group_ids };
				// As the engine does: a deny that needs a target the check does not give could never
				// apply, so nothing is granted (a later allow must not get past it).
				for (const entry of evaluated) {
					if (!covers(entry.resource_types, input.resource_type)) continue;
					if (!covers(entry.actions, input.action)) continue;
					const missing = entry.effect === 'deny' ? missingTarget(entry, input) : null;
					if (missing)
						return {
							allowed: false,
							reason: `A deny rule needs ${missing}, which the check did not give`,
							decided_by: entry.id,
							details,
							evaluated_rules: evaluated.length
						};
				}
				const decided = evaluated.find(
					(entry) =>
						covers(entry.resource_types, input.resource_type) &&
						covers(entry.actions, input.action) &&
						entry.conditions.every((condition) => conditionHolds(condition, subject, resource))
				);
				if (!decided)
					return {
						allowed: false,
						reason: 'No policy matched',
						decided_by: null,
						details,
						evaluated_rules: evaluated.length
					};
				return {
					allowed: decided.effect === 'allow',
					reason:
						decided.effect === 'allow'
							? `Allowed by policy “${decided.name}”`
							: `Denied by policy “${decided.name}”`,
					decided_by: decided.id,
					details,
					evaluated_rules: evaluated.length
				};
			})
	};
}
