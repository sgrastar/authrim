export type MappingAdapter = 'CSV' | 'SAML' | 'OIDC' | 'SCIM';
export type MappingRisk = 'low' | 'medium' | 'high';
export type NodeRole = 'source' | 'target' | 'destination';

export interface MappingNode {
	id: string;
	ruleId: string;
	role: NodeRole;
	adapter?: MappingAdapter;
	label: string;
	caption: string;
	type?: string;
	privacy?: 'PII' | 'non-PII' | 'Other';
	required?: boolean;
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

interface ColumnField {
	name: string;
	meta: string;
	targetId: string;
	transform: string;
	risk?: MappingRisk;
}

const canonicalTargets: MappingNode[] = [
	{
		id: 'canon-email',
		ruleId: 'target-email',
		role: 'target',
		label: 'contact_points.value_storage_ref',
		caption: 'contact_type=email',
		type: 'text',
		privacy: 'PII',
		required: true
	},
	{
		id: 'canon-phone',
		ruleId: 'target-phone',
		role: 'target',
		label: 'contact_points.value_storage_ref',
		caption: 'contact_type=phone',
		type: 'text',
		privacy: 'PII'
	},
	{
		id: 'canon-address',
		ruleId: 'target-address',
		role: 'target',
		label: 'contact_points.value_storage_ref',
		caption: 'contact_type=address',
		type: 'json',
		privacy: 'PII'
	},
	{
		id: 'canon-given-name',
		ruleId: 'target-given',
		role: 'target',
		label: 'profile_attribute_values.value_storage_ref',
		caption: 'catalog_entry_id=given_name',
		type: 'text',
		privacy: 'PII',
		required: true
	},
	{
		id: 'canon-family-name',
		ruleId: 'target-family',
		role: 'target',
		label: 'profile_attribute_values.value_storage_ref',
		caption: 'catalog_entry_id=family_name',
		type: 'text',
		privacy: 'PII',
		required: true
	},
	{
		id: 'canon-display-name',
		ruleId: 'target-display',
		role: 'target',
		label: 'profile_attribute_values.value_storage_ref',
		caption: 'catalog_entry_id=display_name',
		type: 'text',
		privacy: 'PII'
	},
	{
		id: 'canon-org-unit',
		ruleId: 'target-org',
		role: 'target',
		label: 'profile_attribute_values.value_storage_ref',
		caption: 'catalog_entry_id=org_unit',
		type: 'text',
		privacy: 'non-PII'
	},
	{
		id: 'canon-groups',
		ruleId: 'target-groups',
		role: 'target',
		label: 'group_memberships.group_id',
		caption: 'assignment_source=mapped_column',
		type: 'uuid',
		privacy: 'non-PII'
	},
	{
		id: 'canon-binding',
		ruleId: 'target-binding',
		role: 'target',
		label: 'identity_bindings.provider_subject_key_hash',
		caption: 'provider + source scoped',
		type: 'bytes',
		privacy: 'Other',
		required: true
	},
	{
		id: 'canon-subject',
		ruleId: 'target-subject',
		role: 'target',
		label: 'subject_identifiers.identifier_value_hash',
		caption: 'destination scoped',
		type: 'bytes',
		privacy: 'Other',
		required: true
	},
	{
		id: 'canon-lifecycle',
		ruleId: 'target-lifecycle',
		role: 'target',
		label: 'identity_accounts.lifecycle_state',
		caption: 'active / suspended / deleted',
		type: 'enum',
		privacy: 'non-PII',
		required: true
	},
	{
		id: 'canon-assurance',
		ruleId: 'target-assurance',
		role: 'target',
		label: 'identity_assurance_events.evidence_ref',
		caption: 'assurance evidence',
		type: 'json',
		privacy: 'Other'
	},
	{
		id: 'canon-policy',
		ruleId: 'target-policy',
		role: 'target',
		label: 'policy_decisions.evidence_ref',
		caption: 'release and purpose evidence',
		type: 'json',
		privacy: 'Other'
	},
	{
		id: 'canon-audit',
		ruleId: 'target-audit',
		role: 'target',
		label: 'audit_identity_events.event_payload_ref',
		caption: 'column-level trace',
		type: 'json',
		privacy: 'Other'
	}
];

const destinations: MappingNode[] = [
	{
		id: 'dest-oidc-id-token',
		ruleId: 'dest-id-token',
		role: 'destination',
		adapter: 'OIDC',
		label: 'OIDC ID token',
		caption: 'standard and custom claims'
	},
	{
		id: 'dest-oidc-userinfo',
		ruleId: 'dest-userinfo',
		role: 'destination',
		adapter: 'OIDC',
		label: 'OIDC UserInfo',
		caption: 'profile/contact claims'
	},
	{
		id: 'dest-saml-assertion',
		ruleId: 'dest-saml-assertion',
		role: 'destination',
		adapter: 'SAML',
		label: 'SAML assertion',
		caption: 'attribute statement'
	},
	{
		id: 'dest-scim-users',
		ruleId: 'dest-scim-users',
		role: 'destination',
		adapter: 'SCIM',
		label: 'SCIM Users',
		caption: 'provisioning payload'
	},
	{
		id: 'dest-admin-search',
		ruleId: 'dest-admin-search',
		role: 'destination',
		adapter: 'CSV',
		label: 'Admin search index',
		caption: 'operator projection'
	},
	{
		id: 'dest-resolution-center',
		ruleId: 'dest-resolution-center',
		role: 'destination',
		adapter: 'CSV',
		label: 'Mapping Resolution Center',
		caption: 'conflicts and blockers'
	},
	{
		id: 'dest-audit-log',
		ruleId: 'dest-audit-log',
		role: 'destination',
		adapter: 'CSV',
		label: 'Audit log',
		caption: 'trace evidence'
	}
];

const destinationByTarget: Record<string, string[]> = {
	'canon-email': ['dest-oidc-userinfo', 'dest-saml-assertion'],
	'canon-phone': ['dest-oidc-userinfo', 'dest-scim-users'],
	'canon-address': ['dest-oidc-userinfo', 'dest-scim-users'],
	'canon-given-name': ['dest-oidc-id-token', 'dest-saml-assertion'],
	'canon-family-name': ['dest-oidc-id-token', 'dest-saml-assertion'],
	'canon-display-name': ['dest-oidc-id-token', 'dest-admin-search'],
	'canon-org-unit': ['dest-scim-users', 'dest-admin-search'],
	'canon-groups': ['dest-scim-users', 'dest-saml-assertion'],
	'canon-binding': ['dest-saml-assertion', 'dest-admin-search'],
	'canon-subject': ['dest-oidc-id-token', 'dest-saml-assertion'],
	'canon-lifecycle': ['dest-scim-users', 'dest-resolution-center'],
	'canon-assurance': ['dest-oidc-id-token', 'dest-resolution-center'],
	'canon-policy': ['dest-resolution-center', 'dest-audit-log'],
	'canon-audit': ['dest-audit-log']
};

const fields: ColumnField[] = [
	{
		name: 'FederationIdentifier',
		meta: 'binding / stable',
		targetId: 'canon-binding',
		transform: 'hash federation id',
		risk: 'high'
	},
	{
		name: 'User.Username',
		meta: 'login / string',
		targetId: 'canon-binding',
		transform: 'normalize login'
	},
	{
		name: 'User.Email',
		meta: 'pii / email',
		targetId: 'canon-email',
		transform: 'normalize email'
	},
	{
		name: 'User.Phone',
		meta: 'pii / phone',
		targetId: 'canon-phone',
		transform: 'normalize phone'
	},
	{
		name: 'User.MobilePhone',
		meta: 'pii / phone',
		targetId: 'canon-phone',
		transform: 'normalize mobile'
	},
	{
		name: 'User.Street',
		meta: 'pii / address',
		targetId: 'canon-address',
		transform: 'address line'
	},
	{
		name: 'User.City',
		meta: 'pii / address',
		targetId: 'canon-address',
		transform: 'city normalize'
	},
	{
		name: 'User.State',
		meta: 'pii / address',
		targetId: 'canon-address',
		transform: 'region normalize'
	},
	{
		name: 'User.Country',
		meta: 'pii / address',
		targetId: 'canon-address',
		transform: 'country code'
	},
	{
		name: 'User.PostalCode',
		meta: 'pii / address',
		targetId: 'canon-address',
		transform: 'postal normalize'
	},
	{
		name: 'User.FirstName',
		meta: 'pii / profile',
		targetId: 'canon-given-name',
		transform: 'trim string'
	},
	{
		name: 'User.LastName',
		meta: 'pii / profile',
		targetId: 'canon-family-name',
		transform: 'trim string'
	},
	{
		name: 'User.Name',
		meta: 'pii / profile',
		targetId: 'canon-display-name',
		transform: 'display label'
	},
	{
		name: 'User.Title',
		meta: 'profile / title',
		targetId: 'canon-display-name',
		transform: 'title overlay'
	},
	{
		name: 'User.Department',
		meta: 'org / string',
		targetId: 'canon-org-unit',
		transform: 'department catalog'
	},
	{
		name: 'User.Division',
		meta: 'org / string',
		targetId: 'canon-org-unit',
		transform: 'division catalog'
	},
	{
		name: 'User.CompanyName',
		meta: 'org / company',
		targetId: 'canon-org-unit',
		transform: 'company catalog'
	},
	{
		name: 'User.ProfileId',
		meta: 'assignment / salesforce',
		targetId: 'canon-groups',
		transform: 'profile lookup'
	},
	{
		name: 'User.UserRoleId',
		meta: 'assignment / salesforce',
		targetId: 'canon-groups',
		transform: 'role lookup'
	},
	{
		name: 'User.IsActive',
		meta: 'lifecycle / boolean',
		targetId: 'canon-lifecycle',
		transform: 'boolean lifecycle',
		risk: 'high'
	},
	{
		name: 'User.LocaleSidKey',
		meta: 'profile / locale',
		targetId: 'canon-assurance',
		transform: 'locale evidence'
	},
	{
		name: 'User.TimeZoneSidKey',
		meta: 'profile / timezone',
		targetId: 'canon-assurance',
		transform: 'timezone evidence'
	},
	{
		name: 'User.UserType',
		meta: 'policy / enum',
		targetId: 'canon-policy',
		transform: 'release tier'
	},
	{
		name: 'User.ManagerId',
		meta: 'relation / id',
		targetId: 'canon-audit',
		transform: 'manager evidence'
	},
	{
		name: 'WorkdayID__c',
		meta: 'custom / hr id',
		targetId: 'canon-binding',
		transform: 'workday binding'
	}
];

function slug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

function ruleDetail(
	field: ColumnField,
	target?: MappingNode,
	destination?: MappingNode
): RuleDetail {
	return {
		title: `SAML ${field.name}`,
		risk: field.risk ?? (field.meta.includes('pii') ? 'medium' : 'low'),
		source: `SAML adapter / ${field.name}`,
		target: target?.label ?? field.targetId,
		destination: destination
			? `${destination.label} / ${destination.caption}`
			: 'No outbound projection',
		transform: field.transform,
		validation: `${field.meta}; mapped from loaded column sample`,
		release: 'sample policy preview only',
		consentStatus: field.meta.includes('pii') ? 'required' : 'not_required',
		legalBasis: field.meta.includes('pii') ? 'consent' : 'legitimate_interest',
		purpose: field.meta.includes('pii') ? 'profile_release' : 'provisioning',
		attributeSetHash: `attrset_${slug(field.targetId).slice(0, 18)}`,
		consentMode: field.meta.includes('pii') ? 'until_attributes_change' : 'not_applicable',
		releasePolicyVersion: 'release-policy-v1',
		termsVersion: field.meta.includes('pii') ? 'terms-current' : 'not_required',
		privacyPolicyVersion: field.meta.includes('pii') ? 'privacy-current' : 'not_required',
		denyReason: field.meta.includes('regulated') ? 'purpose_not_allowed' : 'none',
		runtime: 'column sample preview',
		conflict: 'sample policy decides precedence',
		disclosure: 'redacted summary',
		dryrunStatus: field.risk === 'high' ? 'review_required' : 'mapped',
		dryrunTone: field.risk === 'high' ? 'warn' : 'ok',
		input: `[column: ${field.name}, adapter=SAML]`,
		output: `${target?.label ?? field.targetId} <= ${field.name}`,
		trace: `${field.name} loaded from a column-heavy sample to test node density and edge readability.`,
		review: field.risk === 'high' ? '1 task' : '0 tasks',
		replay: field.risk === 'high' ? 'yes' : 'no',
		diffSeverity: field.risk ?? 'low',
		diffTitle: 'Column sample mapping',
		diff: [
			'This rule was generated from the selected sample column set.',
			'Adapter selectors bring each source family to the front without moving nodes freely.'
		]
	};
}

export function buildSalesforceSamlPreviewSample(): MappingSample {
	const sourceNodes: MappingNode[] = fields.map((field) => {
		const ruleId = `rule-sf-${slug(field.name)}`;
		return {
			id: `src-sf-${slug(field.name)}`,
			ruleId,
			role: 'source',
			adapter: 'SAML',
			label: field.name,
			caption: field.transform
		};
	});
	const usedTargetIds = [...new Set(fields.map((field) => field.targetId))];
	const targetNodes = canonicalTargets.filter((target) => usedTargetIds.includes(target.id));
	const usedDestinationIds = [
		...new Set(usedTargetIds.flatMap((targetId) => destinationByTarget[targetId] ?? []))
	];
	const destinationNodes = destinations.filter((destination) =>
		usedDestinationIds.includes(destination.id)
	);
	const inboundEdges = fields.map((field) => ({
		id: `rule-sf-${slug(field.name)}`,
		from: `src-sf-${slug(field.name)}`,
		to: field.targetId
	}));
	const outboundEdges = usedTargetIds.flatMap((targetId) =>
		(destinationByTarget[targetId] ?? [])
			.filter((destinationId) => usedDestinationIds.includes(destinationId))
			.map((destinationId) => ({
				id: `out-${targetId}-${destinationId}`,
				from: targetId,
				to: destinationId,
				outbound: true
			}))
	);

	const ruleEntries = fields.map((field) => {
		const target = targetNodes.find((candidate) => candidate.id === field.targetId);
		const destination = destinationNodes.find((candidate) =>
			(destinationByTarget[field.targetId] ?? []).includes(candidate.id)
		);
		return [`rule-sf-${slug(field.name)}`, ruleDetail(field, target, destination)] as const;
	});

	return {
		id: 'saml-salesforce',
		title: 'SAML Salesforce column set',
		snapshot: 'columns_saml_salesforce_025',
		status: 'Dense',
		reviewGates: '25 columns',
		inboundAdapter: 'SAML',
		outboundAdapter: 'OIDC',
		activeRuleId: 'rule-sf-user-email',
		metrics: ['25 / 25', '1.6 avg', '4', 'cat_34'],
		nodes: [...sourceNodes, ...targetNodes, ...destinationNodes],
		edges: [...inboundEdges, ...outboundEdges],
		rules: Object.fromEntries(ruleEntries)
	};
}

export const mappingSamples: MappingSample[] = [buildSalesforceSamlPreviewSample()];
