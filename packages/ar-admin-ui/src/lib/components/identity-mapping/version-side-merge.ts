import type {
	IdentityMappingFieldMappingVersionRuleSummary,
	IdentityMappingFieldMappingVersionSummary
} from '$lib/api/admin-identity-mapping';
import type { MappingDraftPayload, MappingDraftRuleInput, TransformOperation } from './types';

export type MappingVersionSide = 'source' | 'destination';

export function mergeMappingVersionSide(
	draft: MappingDraftPayload,
	existingVersion: IdentityMappingFieldMappingVersionSummary | null,
	side: MappingVersionSide
): { sourceProfileIds: string[]; rules: MappingDraftRuleInput[] } {
	const existingRules = existingVersion?.rules ?? [];
	const preservedRules = existingRules
		.filter((rule) => !ruleBelongsToSide(rule, side))
		.map(storedRuleToDraftRule);
	const replacedRules = existingRules.filter((rule) => ruleBelongsToSide(rule, side));
	const editedRules = draft.rules.map((rule) => preserveUneditedRuleSemantics(rule, replacedRules));
	const mergedRules = [...preservedRules, ...editedRules];
	const firstRule = mergedRules[0];
	if (firstRule) {
		const releaseRules = [
			...(firstRule.releaseRules ?? []),
			...(existingVersion?.releaseRules ?? []).map((rule) => ({
				destinationType: rule.destinationType,
				...(rule.destinationId ? { destinationId: rule.destinationId } : {}),
				sourceRef: rule.sourceRef,
				releaseAction: rule.releaseAction,
				...(rule.legalBasis ? { legalBasis: rule.legalBasis } : {}),
				...(rule.purpose ? { purpose: rule.purpose } : {}),
				condition: rule.condition,
				priority: rule.priority
			}))
		];
		const conflictRules = [
			...(firstRule.conflictRules ?? []),
			...(existingVersion?.conflictRules ?? []).map((rule) => ({
				targetRef: rule.targetRef,
				conflictStrategy: rule.conflictStrategy,
				sourcePriority: rule.sourcePriority,
				condition: rule.condition
			}))
		];
		mergedRules[0] = {
			...firstRule,
			...(releaseRules.length > 0 ? { releaseRules } : {}),
			...(conflictRules.length > 0 ? { conflictRules } : {})
		};
	}
	return {
		sourceProfileIds:
			side === 'source'
				? (draft.sourceProfileIds ?? [])
				: (existingVersion?.sourceProfileIds ?? []),
		rules: mergedRules
	};
}

function ruleBelongsToSide(
	rule: Pick<IdentityMappingFieldMappingVersionRuleSummary, 'ruleKind' | 'edges'>,
	side: MappingVersionSide
): boolean {
	const edgeSides = rule.edges.flatMap((edge) => [
		referenceSide(edge.sourceRef),
		referenceSide(edge.targetRef)
	]);
	if (side === 'source' && edgeSides.includes('source')) return true;
	if (side === 'destination' && edgeSides.includes('destination')) return true;
	return side === 'source'
		? rule.ruleKind.includes('source')
		: rule.ruleKind.includes('destination') || rule.ruleKind.includes('release');
}

function referenceSide(ref: Record<string, unknown>): MappingVersionSide | null {
	const role = typeof ref.role === 'string' ? ref.role : '';
	const profileId = typeof ref.profileId === 'string' ? ref.profileId : '';
	if (
		role === 'source' ||
		profileId.startsWith('source-profile-') ||
		profileId.startsWith('source_profile_')
	) {
		return 'source';
	}
	if (
		role === 'destination' ||
		profileId.startsWith('destination-profile-') ||
		profileId.startsWith('destination_profile_')
	) {
		return 'destination';
	}
	return null;
}

function preserveUneditedRuleSemantics(
	draftRule: MappingDraftRuleInput,
	existingRules: IdentityMappingFieldMappingVersionRuleSummary[]
): MappingDraftRuleInput {
	const signature = ruleEdgeSignature(draftRule);
	const existing = existingRules.find((rule) => ruleEdgeSignature(rule) === signature);
	if (!existing) return draftRule;
	const validationRules = (existing.validationRules ?? []).map((validation) => ({
		targetRef: validation.targetRef,
		validationKind: validation.validationKind,
		severity: validation.severity,
		parameters: validation.parameters
	}));
	return {
		...draftRule,
		...(draftRule.scope === undefined && existing.scope ? { scope: existing.scope } : {}),
		...(draftRule.condition === undefined && existing.condition
			? { condition: existing.condition }
			: {}),
		metadata: { ...(existing.metadata ?? {}), ...(draftRule.metadata ?? {}) },
		...(draftRule.validationRules === undefined && validationRules.length > 0
			? { validationRules }
			: {})
	};
}

function ruleEdgeSignature(rule: Pick<MappingDraftRuleInput, 'ruleKind' | 'edges'>): string {
	const edges = (rule.edges ?? [])
		.map((edge) => `${referenceKey(edge.sourceRef)}>${referenceKey(edge.targetRef)}`)
		.sort();
	return `${rule.ruleKind}:${edges.join('|')}`;
}

function referenceKey(ref: Record<string, unknown>): string {
	const value = (key: string) => (typeof ref[key] === 'string' ? String(ref[key]) : '');
	return [value('namespace'), value('path'), normalizeProfileReference(value('profileId'))].join(
		'\u0000'
	);
}

function normalizeProfileReference(value: string): string {
	return value.replace(/^(?:source|destination)-profile-/u, '');
}

function storedRuleToDraftRule(
	rule: IdentityMappingFieldMappingVersionRuleSummary
): MappingDraftRuleInput {
	return {
		ruleKey: rule.ruleKey,
		ruleKind: rule.ruleKind,
		action: rule.action,
		priority: rule.priority,
		scope: rule.scope,
		condition: rule.condition,
		metadata: rule.metadata,
		edges: rule.edges.map((edge) => ({
			sourceRef: edge.sourceRef,
			targetRef: edge.targetRef,
			edgeKind: edge.edgeKind
		})),
		transforms: rule.transforms.map((transform) => {
			const edgeIndex = transform.edgeId
				? rule.edges.findIndex((edge) => edge.id === transform.edgeId)
				: -1;
			return {
				edgeIndex: edgeIndex >= 0 ? edgeIndex : undefined,
				operation: transform.operation as TransformOperation,
				parameters: transform.parameters
			};
		}),
		validationRules: (rule.validationRules ?? []).map((validation) => ({
			targetRef: validation.targetRef,
			validationKind: validation.validationKind,
			severity: validation.severity,
			parameters: validation.parameters
		}))
	};
}
