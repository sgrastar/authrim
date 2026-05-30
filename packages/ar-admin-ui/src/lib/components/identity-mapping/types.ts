export type MappingAdapter = 'CSV' | 'SAML' | 'OIDC' | 'SCIM';
export type MappingRisk = 'low' | 'medium' | 'high';
export type NodeRole = 'source' | 'transform' | 'target' | 'destination';
export type TransformOperation = 'copy' | 'concat' | 'fallback' | 'normalize' | 'case' | 'trim';

export interface MappingNode {
	id: string;
	ruleId: string;
	role: NodeRole;
	adapter?: MappingAdapter;
	profileId?: string;
	profileTitle?: string;
	label: string;
	caption: string;
	type?: string;
	storageTarget?: string;
	uiGroupKey?: string | null;
	uiGroupLabel?: string | null;
	uiGroupOrder?: number;
	uiFieldOrder?: number;
	examples?: unknown[];
	inputCardinality?: 'one' | 'many';
	locked?: boolean;
	privacy?: 'PII' | 'non-PII' | 'Other';
	required?: boolean;
	transformOperation?: TransformOperation;
	transformParameters?: Record<string, string>;
	layoutPosition?: {
		x: number;
		y: number;
	};
}

export interface MappingEdge {
	id: string;
	from: string;
	to: string;
	outbound?: boolean;
	custom?: boolean;
}

export interface RuleDetail {
	title: string;
	risk: MappingRisk;
	source: string;
	target: string;
	destination: string;
	transform: string;
	validation: string;
	release: string;
	storageTarget?: string;
	consentStatus: 'not_required' | 'required' | 'granted' | 'version_upgrade_required';
	legalBasis: 'consent' | 'legal_obligation' | 'contract' | 'legitimate_interest';
	purpose: string;
	attributeSetHash: string;
	consentMode: 'once' | 'every_time' | 'until_attributes_change' | 'not_applicable';
	releasePolicyVersion: string;
	termsVersion: string;
	privacyPolicyVersion: string;
	denyReason: string;
	runtime: string;
	conflict: string;
	disclosure: string;
	dryrunStatus: string;
	dryrunTone: 'ok' | 'warn' | 'stop';
	input: string;
	output: string;
	trace: string;
	review: string;
	replay: string;
	diffSeverity: MappingRisk;
	diffTitle: string;
	diff: string[];
}

export interface MappingSample {
	id: string;
	title: string;
	snapshot: string;
	status: string;
	reviewGates: string;
	inboundAdapter: MappingAdapter;
	outboundAdapter: MappingAdapter;
	activeRuleId: string;
	metrics: [string, string, string, string];
	nodes: MappingNode[];
	edges: MappingEdge[];
	rules: Record<string, RuleDetail>;
}

export interface MappingDraftEdgeInput {
	sourceRef: Record<string, unknown>;
	targetRef: Record<string, unknown>;
	edgeKind?: string;
}

export interface MappingDraftTransformInput {
	edgeIndex?: number;
	operation: TransformOperation;
	parameters?: Record<string, unknown>;
}

export interface MappingDraftRuleInput {
	ruleKey: string;
	ruleKind: string;
	action: string;
	priority?: number;
	scope?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	edges?: MappingDraftEdgeInput[];
	transforms?: MappingDraftTransformInput[];
}

export interface MappingDraftPayload {
	versionLabel: string;
	compatibilityRange?: string;
	rules: MappingDraftRuleInput[];
	metadata: {
		sampleId: string;
		sampleTitle: string;
		viewMode: 'overview' | 'inbound' | 'outbound';
		edgeCount: number;
		transformCount: number;
	};
}
