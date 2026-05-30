export type MappingAdapter = 'CSV' | 'SAML' | 'OIDC' | 'SCIM';
export type MappingRisk = 'low' | 'medium' | 'high';
export type NodeRole = 'source' | 'transform' | 'target' | 'destination';

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
	inputCardinality?: 'one' | 'many';
	privacy?: 'PII' | 'non-PII' | 'Other';
	required?: boolean;
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
