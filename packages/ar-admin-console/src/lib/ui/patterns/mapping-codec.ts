import {
	conditionFields,
	identifierGraphProblem,
	readMappingCondition,
	validateMappingRuleGraph
} from '@authrim/ar-lib-field-mapping/authoring';
import type {
	FieldRef,
	MappingRuleGraph,
	MappingValueReference
} from '@authrim/ar-lib-field-mapping/contract';
import type { MappingSetContent, MappingSetRule } from '#lib/api/mapping-set.js';
import {
	TRANSFORMS,
	identifierRuntimeParams,
	mappingProblems,
	runtimeTransformParams,
	transformDef,
	type Mapping,
	type MappingField,
	type TransformStep
} from './mapping-model';

/** Catalog/profile references stay with the adapter; the existing editor still uses field keys. */
export interface MappingCodecField extends MappingField {
	ref: FieldRef & { profileId?: string };
}
export interface MappingCodecContext {
	protocol: 'oidc' | 'saml';
	profileId: string;
	sources: readonly MappingCodecField[];
	targets: readonly MappingCodecField[];
}
export type DecodedMappingSet =
	| { editable: true; mappings: Mapping[] }
	| { editable: false; reason: string };

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = (value: Record<string, unknown> | undefined) =>
	!value || Object.keys(value).length === 0;
/** Object key order has no graph meaning; array order does. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (record(value))
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.filter((key) => value[key] !== undefined)
				.map((key) => [key, canonical(value[key])])
		);
	return value;
}
const equal = (a: unknown, b: unknown) =>
	JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fail = (reason: string): never => {
	throw new Error(reason);
};

function field(key: string, fields: readonly MappingCodecField[]): MappingCodecField {
	const matches = fields.filter((item) => item.key === key);
	return matches.length === 1 ? matches[0] : fail(`Unknown or ambiguous field: ${key}`);
}
function checkFieldRef(ref: FieldRef & { profileId?: string }) {
	if (
		Object.keys(ref).some(
			(key) =>
				!['side', 'namespace', 'path', 'catalogEntryId', 'valueType', 'profileId'].includes(key)
		) ||
		typeof ref.namespace !== 'string' ||
		!ref.namespace.trim() ||
		typeof ref.path !== 'string' ||
		!ref.path.trim() ||
		(ref.catalogEntryId !== undefined &&
			(typeof ref.catalogEntryId !== 'string' || !ref.catalogEntryId.trim())) ||
		(ref.valueType !== undefined && (typeof ref.valueType !== 'string' || !ref.valueType.trim())) ||
		(ref.profileId !== undefined && (typeof ref.profileId !== 'string' || !ref.profileId.trim()))
	)
		fail('Unsupported or malformed field reference');
}
function targetField(key: string, context: MappingCodecContext) {
	const target = field(key, context.targets);
	const ref = target.ref;
	checkFieldRef(ref);
	if (
		ref.side !== 'destination' ||
		ref.profileId !== context.profileId ||
		(context.protocol === 'oidc'
			? ref.namespace !== 'oidc.claim'
			: !['saml.attribute', 'saml.nameid'].includes(ref.namespace))
	)
		fail('Target does not belong to the selected protocol and Destination Profile');
	return target;
}
function editorParams(step: TransformStep): TransformStep {
	if (!TRANSFORMS.some((def) => def.id === step.transform)) fail('Unsupported transform');
	return step.transform === 'persistent_identifier'
		? { ...step, params: identifierRuntimeParams(step.params) }
		: structuredClone(step);
}

/** The condition builder owns these node fields and requires a group at the root. */
function consoleConditionNodes(
	condition: NonNullable<ReturnType<typeof readMappingCondition>>
): boolean {
	const known =
		condition.kind === 'group'
			? ['kind', 'match', 'children']
			: ['kind', 'field', 'operator', 'value'];
	return (
		Object.keys(condition).every((key) => known.includes(key)) &&
		(condition.kind !== 'group' || condition.children.every(consoleConditionNodes))
	);
}

/** Compile ordered editor lanes to one explicit graph output. Condition dependencies are edges. */
export function compileMapping(mapping: Mapping, context: MappingCodecContext): MappingSetRule {
	if (
		!mapping.id ||
		new Set(mapping.steps.map((step) => step.id)).size !== mapping.steps.length ||
		mapping.steps.some((step) => !step.id)
	)
		fail('Mapping and step IDs must be unique and nonempty');
	const target = targetField(mapping.target, context);
	const problems = mappingProblems(mapping, context.sources, context.targets);
	if (problems.length) fail(`Invalid editor mapping: ${problems[0].kind}`);
	const clean: Mapping = { ...structuredClone(mapping), steps: mapping.steps.map(editorParams) };
	const edges: NonNullable<MappingSetRule['edges']> = [];
	const addSource = (key: string): MappingValueReference => {
		const source = field(key, context.sources);
		checkFieldRef(source.ref);
		if (source.ref.side !== 'source') fail('Source must be a source field');
		const edgeIndex = edges.length;
		edges.push({ sourceRef: { ...source.ref }, targetRef: { ...target.ref } });
		return { edgeIndex };
	};
	let refs = clean.sources.map(addSource);
	const transforms: NonNullable<MappingSetRule['transforms']> = [];
	const stepIndexes: number[][] = [];
	for (const step of clean.steps) {
		const def = transformDef(step.transform);
		const lanes = def.generates ? [[]] : def.combines ? [refs] : refs.map((ref) => [ref]);
		const expanded: number[] = [];
		refs = lanes.map((lane): MappingValueReference => {
			let inputs = lane;
			if (step.transform === 'conditional') {
				const condition = readMappingCondition(step.params.condition);
				if (!condition || condition.kind !== 'group' || !consoleConditionNodes(condition))
					return fail('Unsupported or invalid editor condition');
				inputs = lane.map((ref) => ({ ...ref, name: 'value' }));
				for (const key of conditionFields(condition)) {
					const source = field(key, context.sources);
					const existing = edges.findIndex((edge) => equal(edge.sourceRef, source.ref));
					const ref = existing >= 0 ? { edgeIndex: existing } : addSource(key);
					inputs.push({ ...ref, name: `field:${key}` });
				}
			}
			const stepIndex = transforms.length;
			transforms.push({
				operation: step.transform,
				parameters: runtimeTransformParams(step),
				inputs
			});
			expanded.push(stepIndex);
			return { stepIndex };
		});
		stepIndexes.push(expanded);
	}
	if (refs.length !== 1) fail('Mapping must have exactly one output');
	const rule: MappingSetRule = {
		ruleKey: mapping.id,
		ruleKind: transforms.length ? 'transform' : 'direct',
		action: 'allow',
		targetRef: { ...target.ref },
		edges,
		transforms,
		output: refs[0],
		metadata: { console: { version: 1, mapping: clean, stepIndexes } }
	};
	validateGraph(rule, context);
	return rule;
}

function runtimeGraph(rule: MappingSetRule, context: MappingCodecContext): MappingRuleGraph {
	const target = context.targets.find((item) => equal(item.ref, rule.targetRef));
	if (!target) return fail('Unknown or malformed target reference');
	targetField(target.key, context);
	const edges = (rule.edges ?? []).map((edge, index) => {
		if (Object.keys(edge).some((key) => !['sourceRef', 'targetRef', 'edgeKind'].includes(key)))
			fail('Unsupported edge settings');
		const source = context.sources.find((item) => equal(item.ref, edge.sourceRef));
		if (
			!source ||
			!equal(edge.targetRef, target.ref) ||
			(edge.edgeKind !== undefined && edge.edgeKind !== 'direct')
		)
			return fail('Unknown, cross-profile or unsupported edge reference');
		return { id: `edge:${index}`, sourceRef: source.ref, targetRef: target.ref };
	});
	const transforms = (rule.transforms ?? []).map((step, index) => {
		if (
			Object.keys(step).some(
				(key) => !['operation', 'inputs', 'parameters', 'targetRef'].includes(key)
			)
		)
			fail('Unsupported transform settings');
		const def = TRANSFORMS.find((def) => def.id === step.operation);
		if (!def || step.targetRef !== undefined)
			return fail('Unsupported transform or transform target');
		return {
			id: `step:${index}`,
			operation: def.id,
			parameters: step.parameters,
			inputs: step.inputs ?? []
		};
	});
	if (!rule.output) return fail('Missing explicit output');
	return {
		id: rule.ruleKey,
		targetRef: target.ref,
		edges,
		transforms,
		output: rule.output,
		pairwiseSubject: target.ref.namespace === 'oidc.claim' && target.ref.path === 'sub'
	};
}
function validateGraph(rule: MappingSetRule, context: MappingCodecContext) {
	for (const step of rule.transforms ?? []) {
		if (step.operation !== 'persistent_identifier') continue;
		const params = step.parameters ?? {};
		if (
			context.protocol === 'oidc'
				? params.format !== 'plain' ||
					params.audience === 'sp_entity_id' ||
					String(params.algorithm).startsWith('simplesamlphp_')
				: params.audience === 'sector'
		)
			fail('Identifier parameters do not fit the release protocol');
	}
	if (rule.targetRef?.namespace === 'saml.nameid') {
		const copy = rule.output && 'edgeIndex' in rule.output && !rule.transforms?.length;
		const identifier =
			rule.output &&
			'stepIndex' in rule.output &&
			rule.transforms?.length === 1 &&
			rule.transforms[rule.output.stepIndex]?.operation === 'persistent_identifier' &&
			rule.transforms[rule.output.stepIndex]?.parameters?.format === 'plain';
		if (!copy && !identifier) fail('NameID requires a plain copy or plain persistent identifier');
	}
	const graph = runtimeGraph(rule, context);
	const identifierProblem = identifierGraphProblem(graph);
	if (identifierProblem) fail(identifierProblem);
	const reasons = validateMappingRuleGraph(graph);
	if (reasons.length) fail(`Invalid graph: ${reasons[0].code}`);
	return graph;
}
function readMapping(value: unknown): Mapping | null {
	if (
		!record(value) ||
		Object.keys(value).some((key) => !['id', 'target', 'sources', 'steps'].includes(key)) ||
		typeof value.id !== 'string' ||
		typeof value.target !== 'string' ||
		!Array.isArray(value.sources) ||
		!value.sources.every((source): source is string => typeof source === 'string') ||
		!Array.isArray(value.steps)
	)
		return null;
	const steps: TransformStep[] = [];
	for (const step of value.steps) {
		if (
			!record(step) ||
			Object.keys(step).some((key) => !['id', 'transform', 'params'].includes(key)) ||
			typeof step.id !== 'string' ||
			!record(step.params)
		)
			return null;
		const def = TRANSFORMS.find((def) => def.id === step.transform);
		if (!def) return null;
		const params: TransformStep['params'] = {};
		for (const [key, param] of Object.entries(step.params)) {
			if (typeof param !== 'string' && typeof param !== 'boolean') return null;
			params[key] = param;
		}
		steps.push({ id: step.id, transform: def.id, params });
	}
	return { id: value.id, target: value.target, sources: value.sources, steps };
}
function comparable(rule: MappingSetRule) {
	return {
		ruleKey: rule.ruleKey,
		ruleKind: rule.ruleKind,
		action: rule.action,
		targetRef: rule.targetRef,
		output: rule.output,
		edges: (rule.edges ?? []).map((edge) => ({
			sourceRef: edge.sourceRef,
			targetRef: edge.targetRef
		})),
		transforms: (rule.transforms ?? []).map((step) => ({
			operation: step.operation,
			inputs: step.inputs ?? [],
			parameters: step.parameters ?? {}
		}))
	};
}

/** Infer only the editor's lane structure. Recompilation below must prove that nothing was lost. */
function inferMapping(rule: MappingSetRule, context: MappingCodecContext): Mapping {
	const target = context.targets.find((item) => equal(item.ref, rule.targetRef));
	if (!target) return fail('Unknown target');
	const transforms = rule.transforms ?? [];
	const conditionEdges = new Set(
		transforms.flatMap((step) =>
			(step.inputs ?? []).flatMap((input) =>
				input.name?.startsWith('field:') && 'edgeIndex' in input ? [input.edgeIndex] : []
			)
		)
	);
	const valueEdges = new Set(
		transforms.flatMap((step) =>
			(step.inputs ?? []).flatMap((input) =>
				!input.name?.startsWith('field:') && 'edgeIndex' in input ? [input.edgeIndex] : []
			)
		)
	);
	if (rule.output && 'edgeIndex' in rule.output) valueEdges.add(rule.output.edgeIndex);
	const sources = (rule.edges ?? []).flatMap((edge, index) =>
		conditionEdges.has(index) && !valueEdges.has(index)
			? []
			: [fieldKey(edge.sourceRef, context.sources)]
	);
	const steps: TransformStep[] = [];
	let lanes = sources.length;
	for (let index = 0; index < transforms.length; ) {
		const current = transforms[index];
		const def = TRANSFORMS.find((def) => def.id === current.operation);
		if (!def) return fail('Unsupported operation');
		const size = def.generates || def.combines ? 1 : lanes;
		if (!size || index + size > transforms.length)
			return fail('Graph cannot be represented by editor lanes');
		const params: TransformStep['params'] = {};
		for (const [key, value] of Object.entries(current.parameters ?? {})) {
			if (typeof value === 'string' || typeof value === 'boolean') params[key] = value;
			else if (
				def.id === 'constant_number' &&
				key === 'value' &&
				typeof value === 'number' &&
				Number.isFinite(value)
			)
				params[key] = String(value);
			else return fail('Unsupported typed transform parameter');
		}
		steps.push({ id: `${rule.ruleKey}:step:${index}`, transform: def.id, params });
		index += size;
		if (def.generates || def.combines) lanes = 1;
	}
	return { id: rule.ruleKey, target: target.key, sources, steps };
}
function fieldKey(ref: Record<string, unknown>, fields: readonly MappingCodecField[]) {
	return fields.find((item) => equal(item.ref, ref))?.key ?? fail('Unknown source reference');
}
function decodeRule(rule: MappingSetRule, context: MappingCodecContext): Mapping {
	if (
		Object.keys(rule).some(
			(key) =>
				![
					'ruleKey',
					'ruleKind',
					'action',
					'targetRef',
					'output',
					'priority',
					'scope',
					'condition',
					'metadata',
					'edges',
					'transforms',
					'validationRules',
					'releaseRules',
					'conflictRules'
				].includes(key)
		)
	)
		fail('Unsupported rule settings');
	if (
		!empty(rule.scope) ||
		!empty(rule.condition) ||
		(rule.priority ?? 0) !== 0 ||
		rule.action !== 'allow' ||
		(rule.validationRules?.length ?? 0) ||
		(rule.releaseRules?.length ?? 0) ||
		(rule.conflictRules?.length ?? 0)
	)
		fail('Unsupported scope, condition, validation, release or conflict settings');
	validateGraph(rule, context);
	let mapping: Mapping;
	if (!empty(rule.metadata)) {
		const metadata = rule.metadata;
		if (
			!metadata ||
			Object.keys(metadata).some((key) => key !== 'console') ||
			!record(metadata.console) ||
			Object.keys(metadata.console).some(
				(key) => !['version', 'mapping', 'stepIndexes'].includes(key)
			) ||
			metadata.console.version !== 1
		)
			return fail('Unsupported metadata');
		const saved = readMapping(metadata.console.mapping);
		if (!saved) return fail('Invalid console editor metadata');
		mapping = saved;
		const rebuilt = compileMapping(mapping, context);
		if (!equal(rebuilt.metadata, metadata)) fail('Lossy or mismatched console editor metadata');
	} else mapping = inferMapping(rule, context);
	const rebuilt = compileMapping(mapping, context);
	if (!equal(comparable(rebuilt), comparable(rule)))
		fail('Stored graph cannot be represented losslessly by the editor');
	return mapping;
}
export function decompileMappingSet(
	content: MappingSetContent,
	context: MappingCodecContext
): DecodedMappingSet {
	try {
		if (
			Object.keys(content).some(
				(key) =>
					!['catalogVersionId', 'compatibilityRange', 'sourceProfileIds', 'rules'].includes(key)
			)
		)
			fail('Unsupported Mapping Set settings');
		if (new Set(content.rules.map((rule) => rule.ruleKey)).size !== content.rules.length)
			fail('Duplicate mapping IDs');
		const mappings = content.rules.map((rule) => decodeRule(rule, context));
		if (new Set(mappings.map((mapping) => mapping.target)).size !== mappings.length)
			fail('Multiple writers for one editor target');
		return { editable: true, mappings };
	} catch (error) {
		return {
			editable: false,
			reason: error instanceof Error ? error.message : 'Unsupported Mapping Set'
		};
	}
}
/** Keep the original shape for unchanged rules, including omitted defaults and stable metadata. */
export function compileMappingSet(
	content: MappingSetContent,
	mappings: readonly Mapping[],
	context: MappingCodecContext
): MappingSetContent {
	const decoded = decompileMappingSet(content, context);
	if (!decoded.editable) return fail(decoded.reason);
	if (
		new Set(mappings.map((mapping) => mapping.id)).size !== mappings.length ||
		new Set(mappings.map((mapping) => mapping.target)).size !== mappings.length
	)
		fail('Duplicate mapping IDs or targets');
	return {
		...structuredClone(content),
		rules: mappings.map((mapping) => {
			const previous = decoded.mappings.find((item) => item.id === mapping.id);
			const original = content.rules.find((rule) => rule.ruleKey === mapping.id);
			return original && equal(previous, mapping)
				? structuredClone(original)
				: compileMapping(mapping, context);
		})
	};
}
