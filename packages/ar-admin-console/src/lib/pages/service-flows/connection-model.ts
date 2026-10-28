import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
import type { WizardStep } from '$lib/ui/patterns/WizardSteps.svelte';

/**
 * What "Add connection" asks, what the connection's detail screen lays out, and when each lets
 * you go on. The wording is dummy copy for the mock; the shape (which steps follow which
 * answers) is what is being tried.
 *
 * Every word shown is a message key (`sf.*`), turned into text when it is asked for, so a change
 * of language reaches every screen; nothing here keeps a translated string.
 *
 * Two questions come first. Which way: an app or service that uses Authrim to sign people in
 * (`out`: Authrim is the identity provider) or another provider that Authrim signs people in
 * through (`in`: Authrim is the relying party). Then who, which is where the four kinds are:
 *
 * - `rp`  an OpenID Connect app, which uses Authrim as its OP (out)
 * - `sp`  a SAML service, which uses Authrim as its IdP (out)
 * - `op`  an OpenID Connect provider that Authrim signs people in through (in)
 * - `idp` a SAML identity provider that Authrim signs people in through (in)
 *
 * The wizard asks only what a connection cannot start without. Everything else is a part of
 * the connection's flow, set on its detail screen, where the parts the wizard did not ask are
 * shown as not set yet.
 */
export type Direction = 'out' | 'in';
export type ConnectionKind = 'rp' | 'sp' | 'op' | 'idp';
export type AppType = 'web' | 'spa' | 'native';
export type ImportMode = 'url' | 'file' | 'manual';
/** How a person who signs in through an upstream provider is matched to an Authrim account. */
export type LinkRule = 'verified-email' | 'ask' | 'new';

export const KINDS_OF: Record<Direction, readonly ConnectionKind[]> = {
	out: ['rp', 'sp'],
	in: ['op', 'idp']
};

/** What reading the other side's details needs, for a SAML partner in either direction. */
export interface ImportForm {
	importMode: ImportMode;
	metadataUrl: string;
	/** The metadata at the URL has been read (dummy). */
	fetched: boolean;
	fileName: string;
	entityId: string;
	/** The partner's sign-in address: the ACS of a service, the SSO address of a provider. */
	acsUrl: string;
}

export interface RpForm {
	name: string;
	appType: AppType;
	redirectUris: string[];
	authMethod: string;
	pkce: boolean;
	scopes: string[];
	mappingSet: string;
	/** What Authrim gives the app (its issuer and addresses) has been registered on its side. */
	shared: boolean;
}

export interface SpForm extends ImportForm {
	nameIdFormat: string;
	attributePreset: string;
	minAuth: string;
	consent: boolean;
	/** What Authrim gives the service has been registered on its side. */
	shared: boolean;
	/** The test connection has been run (dummy). */
	tested: boolean;
}

export interface OpForm {
	name: string;
	issuer: string;
	/** The discovery document at the issuer has been read (dummy). */
	discovered: boolean;
	clientId: string;
	clientSecret: string;
	attributePreset: string;
	link: LinkRule;
	shared: boolean;
	tested: boolean;
}

export interface IdpForm extends ImportForm {
	name: string;
	attributePreset: string;
	link: LinkRule;
	shared: boolean;
	tested: boolean;
}

export interface Answers {
	direction: Direction | '';
	kind: ConnectionKind | '';
	rp: RpForm;
	sp: SpForm;
	op: OpForm;
	idp: IdpForm;
	/** "Activate" was pressed on the detail screen. */
	active: boolean;
	/** The optional steps of the flow that were added with its "+" (see FlowGroup.optional). */
	added: string[];
	/** The settings of the optional steps. */
	extras: ExtrasForm;
}

/** The consent statements the tenant keeps (dummy). */
const CONSENT_STATEMENTS = [
	{ value: 'tos', label: 'sf.consent.tos' },
	{ value: 'privacy', label: 'sf.consent.privacy' },
	{ value: 'marketing', label: 'sf.consent.marketing' }
] as const satisfies readonly { value: string; label: MessageKey }[];

/** The sign-up flows the tenant has, for a connection to choose from (dummy; names are not translated). */
export const SIGNUP_FLOWS: readonly { value: string; label: string }[] = [
	{ value: 'standard', label: 'Standard sign-up' },
	{ value: 'partner-portal', label: 'Partner portal sign-up' }
];

/** The consent statements, in the current language. */
export function consentStatements(): { value: string; label: string }[] {
	return CONSENT_STATEMENTS.map((statement) => ({
		value: statement.value,
		label: t(statement.label)
	}));
}

/**
 * The settings of the steps that process what passes through the flow (mapping, additional input,
 * consent, role assignment). They come from the earlier service-flow mock: a connection may have
 * them or not, which is why they are added with the flow's "+" (mapping is there from the start
 * for a service and for a SAML provider, which cannot work without one).
 */
export interface ExtrasForm {
	/** Empty is unset: a mapping only runs with what was chosen, never with a default in the code. */
	inputSchema: string;
	outputSchema: string;
	/** The mapping set that turns the input into the output; empty until one is chosen. */
	mappingSet: string;
	/** Attributes to ask the person for when the other side did not send them. */
	additionalFields: string[];
	consentStatements: string[];
	consentPolicy: string;
	role: string;
	/** The sign-up flow people who arrive without an account go through (empty: none chosen). */
	signupFlow: string;
}

function emptyImport(): ImportForm {
	return {
		importMode: 'url',
		metadataUrl: '',
		fetched: false,
		fileName: '',
		entityId: '',
		acsUrl: ''
	};
}

export function emptyAnswers(): Answers {
	return {
		direction: '',
		kind: '',
		active: false,
		added: [],
		extras: {
			inputSchema: '',
			outputSchema: '',
			mappingSet: '',
			additionalFields: [],
			consentStatements: [],
			consentPolicy: '',
			role: '',
			signupFlow: ''
		},
		rp: {
			name: '',
			appType: 'web',
			redirectUris: [],
			authMethod: 'client_secret_basic',
			pkce: true,
			scopes: ['openid', 'profile'],
			// Not preselected: the mapping applies only if someone picks a set.
			mappingSet: '',
			shared: false
		},
		sp: {
			...emptyImport(),
			nameIdFormat: 'persistent',
			attributePreset: 'standard',
			minAuth: 'none',
			consent: false,
			shared: false,
			tested: false
		},
		op: {
			name: '',
			issuer: '',
			discovered: false,
			clientId: '',
			clientSecret: '',
			attributePreset: 'standard',
			link: 'verified-email',
			shared: false,
			tested: false
		},
		idp: {
			...emptyImport(),
			name: '',
			attributePreset: 'standard',
			link: 'verified-email',
			shared: false,
			tested: false
		}
	};
}

/** The name of every part of a flow (and of the wizard's two questions), as a message key. */
const LABELS: Record<string, MessageKey> = {
	where: 'sf.part.where',
	kind: 'sf.part.kind',
	'rp-app': 'sf.part.rp-app',
	'rp-redirect': 'sf.part.rp-redirect',
	'rp-signin': 'sf.part.rp-signin',
	'rp-info': 'sf.part.rp-info',
	'rp-share': 'sf.part.rp-share',
	'sp-import': 'sf.part.sp-import',
	'sp-share': 'sf.part.share',
	'sp-attrs': 'sf.part.sp-attrs',
	'sp-test': 'sf.part.test',
	'op-details': 'sf.part.providerDetails',
	'op-share': 'sf.part.share',
	'op-attrs': 'sf.part.attrsTaken',
	'op-link': 'sf.part.link',
	'op-test': 'sf.part.test',
	'idp-import': 'sf.part.providerDetails',
	'idp-share': 'sf.part.share',
	'idp-attrs': 'sf.part.attrsTaken',
	'idp-link': 'sf.part.link',
	'idp-test': 'sf.part.test',
	'mapping-schemas': 'sf.part.mapping-schemas',
	'mapping-sets': 'sf.part.mapping-sets',
	additional: 'sf.part.additional',
	'consent-statements': 'sf.part.consent-statements',
	'consent-policies': 'sf.part.consent-policies',
	role: 'sf.part.role',
	'signup-flow': 'sf.part.signup-flow',
	activate: 'sf.part.activate'
};

/**
 * What the wizard asks for each kind, after the two questions: only what it cannot start without.
 * The wizard only helps with the first input: it never tests a connection, and a provider that
 * Authrim signs in through (`op`) needs nothing more than being chosen. Everything it did not ask
 * (details, matching of people, the test) is a setting of the connection's flow, where the
 * overview shows what was entered and what is still to do.
 */
const WIZARD: Record<ConnectionKind, readonly string[]> = {
	rp: ['rp-app', 'rp-signin'],
	sp: ['sp-import', 'sp-attrs'],
	op: [],
	idp: ['idp-import']
};

/** A step of a connection's flow, and the settings in it. */
export interface FlowGroup {
	id: string;
	/** Its name, as a message key: see `groupLabel`. */
	label: MessageKey;
	/** The parts (settings) the step holds, in the order they are listed. */
	parts: readonly string[];
	/** Not there at first: added with the flow's "+" and taken away again with its ×. */
	optional?: boolean;
}

/** Every step of a connection's flow, with its settings, in the order the flow draws them. */
export const FLOW_GROUPS: Record<ConnectionKind, readonly FlowGroup[]> = {
	rp: [
		{ id: 'app', label: 'sf.group.app', parts: ['rp-app', 'rp-redirect'] },
		{ id: 'signin', label: 'sf.group.signin', parts: ['rp-signin'] },
		{ id: 'signup', label: 'sf.group.signup', parts: ['signup-flow'], optional: true },
		{ id: 'receives', label: 'sf.group.receives', parts: ['rp-info'] },
		{
			id: 'mapping',
			label: 'sf.group.mapping',
			parts: ['mapping-schemas', 'mapping-sets'],
			optional: true
		},
		{
			id: 'consent',
			label: 'sf.group.consent',
			parts: ['consent-statements', 'consent-policies'],
			optional: true
		},
		{ id: 'role', label: 'sf.group.role', parts: ['role'], optional: true },
		{ id: 'live', label: 'sf.group.live', parts: ['activate'] }
	],
	sp: [
		{ id: 'service', label: 'sf.group.service', parts: ['sp-import'] },
		{ id: 'response', label: 'sf.group.response', parts: ['sp-attrs'] },
		{ id: 'mapping', label: 'sf.group.mapping', parts: ['mapping-schemas', 'mapping-sets'] },
		{
			id: 'consent',
			label: 'sf.group.consent',
			parts: ['consent-statements', 'consent-policies'],
			optional: true
		},
		{ id: 'role', label: 'sf.group.role', parts: ['role'], optional: true },
		{ id: 'check', label: 'sf.group.check', parts: ['sp-test'] },
		{ id: 'live', label: 'sf.group.live', parts: ['activate'] }
	],
	op: [
		{ id: 'provider', label: 'sf.group.provider', parts: ['op-details'] },
		{ id: 'accounts', label: 'sf.group.accounts', parts: ['op-attrs', 'op-link'] },
		{ id: 'signup', label: 'sf.group.signup', parts: ['signup-flow'], optional: true },
		{
			id: 'mapping',
			label: 'sf.group.mapping',
			parts: ['mapping-schemas', 'mapping-sets'],
			optional: true
		},
		{ id: 'additional', label: 'sf.group.additional', parts: ['additional'], optional: true },
		{
			id: 'consent',
			label: 'sf.group.consent',
			parts: ['consent-statements', 'consent-policies'],
			optional: true
		},
		{ id: 'role', label: 'sf.group.role', parts: ['role'], optional: true },
		{ id: 'check', label: 'sf.group.check', parts: ['op-test'] },
		{ id: 'live', label: 'sf.group.live', parts: ['activate'] }
	],
	idp: [
		{ id: 'provider', label: 'sf.group.provider', parts: ['idp-import'] },
		{ id: 'accounts', label: 'sf.group.accounts', parts: ['idp-attrs', 'idp-link'] },
		{ id: 'signup', label: 'sf.group.signup', parts: ['signup-flow'], optional: true },
		{ id: 'mapping', label: 'sf.group.mapping', parts: ['mapping-schemas', 'mapping-sets'] },
		{ id: 'additional', label: 'sf.group.additional', parts: ['additional'], optional: true },
		{
			id: 'consent',
			label: 'sf.group.consent',
			parts: ['consent-statements', 'consent-policies'],
			optional: true
		},
		{ id: 'role', label: 'sf.group.role', parts: ['role'], optional: true },
		{ id: 'check', label: 'sf.group.check', parts: ['idp-test'] },
		{ id: 'live', label: 'sf.group.live', parts: ['activate'] }
	]
};

/**
 * What Authrim gives the other side to register on theirs (its issuer and addresses, its
 * metadata). It is not a step of the flow, so it is not drawn in it: the detail screen shows it
 * below the overview, as a frame of its own.
 */
export const SHARE_PART: Record<ConnectionKind, string> = {
	rp: 'rp-share',
	sp: 'sp-share',
	op: 'op-share',
	idp: 'idp-share'
};

/** The name of a step of the flow, in the current language. */
export function groupLabel(group: FlowGroup): string {
	return t(group.label);
}

/** The parts that belong to the processing steps (mapping, additional input, consent, role). */
export const EXTRA_PARTS: readonly string[] = [
	'mapping-schemas',
	'mapping-sets',
	'additional',
	'consent-statements',
	'consent-policies',
	'role',
	'signup-flow'
];

/** Every part of a connection's flow, flat. */
export const FLOW: Record<ConnectionKind, readonly string[]> = {
	rp: FLOW_GROUPS.rp.flatMap((group) => group.parts),
	sp: FLOW_GROUPS.sp.flatMap((group) => group.parts),
	op: FLOW_GROUPS.op.flatMap((group) => group.parts),
	idp: FLOW_GROUPS.idp.flatMap((group) => group.parts)
};

const KIND_PROTOCOL: Record<ConnectionKind, MessageKey> = {
	rp: 'sf.protocol.rp',
	sp: 'sf.protocol.sp',
	op: 'sf.protocol.op',
	idp: 'sf.protocol.idp'
};

/** What a kind is, as protocol and role, for the line above the step count. */
export function kindProtocol(kind: ConnectionKind): string {
	return t(KIND_PROTOCOL[kind]);
}

/** Nothing has been entered yet: leaving costs nothing. */
export function isPristine(a: Answers): boolean {
	return JSON.stringify(a) === JSON.stringify(emptyAnswers());
}

/** What the person is told before leaving a wizard that has answers in it. */
export function leaveDialog(): { title: string; body: string; confirm: string; keep: string } {
	return {
		title: t('sf.leave.title'),
		body: t('sf.leave.body'),
		confirm: t('sf.leave.confirm'),
		keep: t('sf.leave.keep')
	};
}

/**
 * Which side Authrim is on, in words, for every screen of a connection. The kind names (RP, SP,
 * OP, IdP) say who the other side is; this says what Authrim does for it.
 */
export function kindRole(kind: ConnectionKind): { badge: string; line: string } {
	const keys: Record<ConnectionKind, { badge: MessageKey; line: MessageKey }> = {
		rp: { badge: 'sf.role.out.badge', line: 'sf.role.rp.line' },
		sp: { badge: 'sf.role.out.badge', line: 'sf.role.sp.line' },
		op: { badge: 'sf.role.in.badge', line: 'sf.role.in.line' },
		idp: { badge: 'sf.role.in.badge', line: 'sf.role.in.line' }
	};
	return { badge: t(keys[kind].badge), line: t(keys[kind].line) };
}

/** The short name of each kind, as a mark beside its name. */
export const KIND_MARK: Record<ConnectionKind, string> = {
	rp: 'RP',
	sp: 'SP',
	op: 'OP',
	idp: 'IdP'
};

export function labelOf(stepId: string): string {
	const key = LABELS[stepId];
	return key ? t(key) : stepId;
}

/** The kind, if it is one that goes with the direction chosen. */
function kindOf(a: Pick<Answers, 'direction' | 'kind'>): ConnectionKind | '' {
	return a.direction && a.kind && KINDS_OF[a.direction].includes(a.kind) ? a.kind : '';
}

/** The wizard's steps for the answers so far: the two questions, then the chosen kind's own. */
export function stepsFor(answers: Pick<Answers, 'direction' | 'kind'>): WizardStep[] {
	const kind = kindOf(answers);
	const ids = ['where', 'kind', ...(kind ? WIZARD[kind] : [])];
	return ids.map((id) => ({ id, label: labelOf(id) }));
}

/** App types that cannot keep a secret use no client secret and always use PKCE. */
export function defaultsForAppType(appType: AppType): Pick<RpForm, 'authMethod' | 'pkce'> {
	return appType === 'web'
		? { authMethod: 'client_secret_basic', pkce: true }
		: { authMethod: 'none', pkce: true };
}

/** A problem with one redirect URI, or nothing. */
export function redirectUriProblem(value: string): string | undefined {
	if (/[*#]/.test(value)) return t('sf.error.wildcard');
	if (/^https:\/\/[^/\s]+/.test(value)) return undefined;
	if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value)) return undefined;
	if (/^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]*:\/[^\s]*$/i.test(value)) return undefined;
	return t('sf.error.redirect');
}

export function httpsUrlProblem(value: string): string | undefined {
	return /^https:\/\/[^/\s]+/.test(value) ? undefined : t('sf.error.https');
}

export function entityIdProblem(value: string): string | undefined {
	return /^(https:\/\/|urn:)\S+$/.test(value) ? undefined : t('sf.error.entityId');
}

/** What reading a metadata address would give, made up from the address (dummy). */
export function dummyMetadata(url: string): {
	entityId: string;
	acsUrl: string;
	certificate: string;
} {
	const host = /^https:\/\/([^/\s]+)/.exec(url)?.[1] ?? 'partner.example';
	return {
		entityId: `https://${host}/saml/metadata`,
		acsUrl: `https://${host}/saml/acs`,
		certificate: 'SHA-256 7C:1A:9E:44:B2:0D:F3:58 …'
	};
}

/** Whether the other side's details are complete, by the way they were given. */
export function importReady(form: ImportForm): boolean {
	if (form.importMode === 'url') return !httpsUrlProblem(form.metadataUrl) && form.fetched;
	if (form.importMode === 'file') return form.fileName !== '';
	return !entityIdProblem(form.entityId) && !httpsUrlProblem(form.acsUrl);
}

function opReady(f: OpForm): boolean {
	return (
		!httpsUrlProblem(f.issuer) && f.discovered && f.clientId.trim() !== '' && f.clientSecret !== ''
	);
}

/** Whether the person may leave this step of the wizard. */
export function canProceed(stepId: string, a: Answers): boolean {
	switch (stepId) {
		case 'where':
			return a.direction !== '';
		case 'kind':
			return kindOf(a) !== '';
		case 'rp-app':
			return a.rp.name.trim() !== '';
		case 'sp-import':
			return importReady(a.sp);
		case 'sp-test':
			return a.sp.tested;
		case 'op-details':
			return opReady(a.op);
		case 'op-test':
			return a.op.tested;
		case 'idp-import':
			return importReady(a.idp);
		case 'idp-test':
			return a.idp.tested;
		default:
			return true;
	}
}

/** The tenant's own issuer: fixed, not entered anywhere; the app is told it in the RP's details. */
export const TENANT_ISSUER = 'https://acme.authrim.example';

export interface SchemaOption {
	value: string;
	label: string;
}

/**
 * The schemas to choose from. Going out (an app or a service signs in through Authrim) the input is
 * the Authrim user and the output is what the other side receives; coming in it is the other way
 * round. None is preselected.
 */
export function schemaOptions(outbound: boolean): {
	inputs: readonly SchemaOption[];
	outputs: readonly SchemaOption[];
} {
	const authrim: SchemaOption[] = [
		{ value: 'authrim', label: t('sf.schema.authrim') },
		{ value: 'extended', label: t('sf.schema.authrimExtended') }
	];
	return outbound
		? {
				inputs: authrim,
				outputs: [
					{ value: 'standard', label: t('sf.schema.serviceReceives') },
					{ value: 'extended', label: t('sf.schema.standardPlusCustom') }
				]
			}
		: {
				inputs: [
					{ value: 'standard', label: t('sf.schema.providerStandard') },
					{ value: 'extended', label: t('sf.schema.standardPlusCustom') }
				],
				outputs: authrim
			};
}

/**
 * The stored choice if this direction offers it, otherwise empty. There is no default to fall
 * back on: a mapping only works with what was explicitly chosen.
 */
export function validSchema(stored: string, options: readonly SchemaOption[]): string {
	return options.some((option) => option.value === stored) ? stored : '';
}

/** Kinds whose flow always has a mapping, and cannot be used without a mapping set. */
const MAPPING_REQUIRED: readonly ConnectionKind[] = ['sp', 'idp'];

/** How far a part of the flow has got, as the detail screen shows it. */
export type PartState = 'done' | 'required' | 'todo';

export function partState(stepId: string, a: Answers): PartState {
	switch (stepId) {
		case 'rp-app':
			return a.rp.name.trim() !== '' ? 'done' : 'required';
		case 'rp-redirect':
			return a.rp.redirectUris.length > 0 && a.rp.redirectUris.every((u) => !redirectUriProblem(u))
				? 'done'
				: 'required';
		case 'rp-info':
			return a.rp.scopes.includes('openid') ? 'done' : 'required';
		case 'rp-share':
			return a.rp.shared ? 'done' : 'todo';
		case 'sp-import':
			return importReady(a.sp) ? 'done' : 'required';
		case 'sp-share':
			return a.sp.shared ? 'done' : 'todo';
		case 'sp-test':
			return a.sp.tested ? 'done' : 'todo';
		case 'op-details':
			return opReady(a.op) ? 'done' : 'required';
		case 'op-share':
			return a.op.shared ? 'done' : 'todo';
		case 'op-test':
			return a.op.tested ? 'done' : 'todo';
		case 'idp-import':
			return importReady(a.idp) ? 'done' : 'required';
		case 'idp-share':
			return a.idp.shared ? 'done' : 'todo';
		case 'idp-test':
			return a.idp.tested ? 'done' : 'todo';
		case 'mapping-schemas': {
			// Both have to be chosen; a value this direction does not offer counts as not chosen.
			const { inputs, outputs } = schemaOptions(!KINDS_OF.in.includes(a.kind as ConnectionKind));
			return validSchema(a.extras.inputSchema, inputs) &&
				validSchema(a.extras.outputSchema, outputs)
				? 'done'
				: MAPPING_REQUIRED.includes(a.kind as ConnectionKind)
					? 'required'
					: 'todo';
		}
		case 'mapping-sets':
			// A service and a SAML provider cannot work without a set; elsewhere it is optional.
			return a.extras.mappingSet
				? 'done'
				: MAPPING_REQUIRED.includes(a.kind as ConnectionKind)
					? 'required'
					: 'todo';
		case 'additional':
			return a.extras.additionalFields.length > 0 ? 'done' : 'todo';
		case 'consent-statements':
			return a.extras.consentStatements.length > 0 ? 'done' : 'todo';
		case 'consent-policies':
			return a.extras.consentPolicy ? 'done' : 'todo';
		case 'role':
			return a.extras.role ? 'done' : 'todo';
		case 'signup-flow':
			return a.extras.signupFlow ? 'done' : 'todo';
		case 'activate':
			return a.active ? 'done' : 'todo';
		default:
			// sign-in method, attributes, matching: they start with a sensible default.
			return 'done';
	}
}

/** The steps of the flow as it is now: the fixed ones and the optional ones that were added. */
export function visibleGroups(a: Answers): FlowGroup[] {
	const kind = kindOf(a);
	return kind
		? FLOW_GROUPS[kind].filter((group) => !group.optional || a.added.includes(group.id))
		: [];
}

function visibleParts(a: Answers): string[] {
	return visibleGroups(a).flatMap((group) => group.parts);
}

/** How far a whole step of the flow has got, from its settings. */
export function groupState(group: FlowGroup, a: Answers): 'done' | 'partial' | 'todo' | 'required' {
	const states = group.parts.map((id) => partState(id, a));
	if (states.includes('required')) return 'required';
	if (states.every((state) => state === 'done')) return 'done';
	return states.includes('done') ? 'partial' : 'todo';
}

/** The settings of the flow still to be done, required ones first (activating is not one). */
export function stillToDo(a: Answers): { id: string; label: string; state: PartState }[] {
	const kind = kindOf(a);
	if (!kind) return [];
	const open = visibleParts(a)
		.filter((id) => id !== 'activate')
		.map((id) => ({ id, label: labelOf(id), state: partState(id, a) }))
		.filter((part) => part.state !== 'done');
	return [
		...open.filter((p) => p.state === 'required'),
		...open.filter((p) => p.state !== 'required')
	];
}

/** The parts of the flow that are still required, by name. */
export function missingParts(a: Answers): string[] {
	const kind = kindOf(a);
	if (!kind) return [];
	return visibleParts(a)
		.filter((id) => partState(id, a) === 'required')
		.map(labelOf);
}

/** A connection may be activated once nothing required is missing and its test has passed. */
export function canActivate(a: Answers): boolean {
	const kind = kindOf(a);
	if (!kind) return false;
	const tested = { rp: true, sp: a.sp.tested, op: a.op.tested, idp: a.idp.tested }[kind];
	return missingParts(a).length === 0 && tested;
}

/** The name the connection goes by on the detail screen. */
export function nameOf(a: Answers): string {
	switch (kindOf(a)) {
		case 'rp':
			return a.rp.name || t('sf.name.newApp');
		case 'sp':
			return entityOf(a.sp).replace(/^https:\/\/|\/saml\/metadata$/g, '');
		case 'op':
			return a.op.name || t('sf.name.newProvider');
		case 'idp':
			return a.idp.name || t('sf.name.newProvider');
		default:
			return t('sf.name.newConnection');
	}
}

export interface ReviewRow {
	label: string;
	value: string;
}

/** The name of each app type, as a message key (the wizard's cards use the same names). */
export const APP_TYPES: Record<AppType, MessageKey> = {
	web: 'sf.appType.web',
	spa: 'sf.appType.spa',
	native: 'sf.appType.native'
};

const LINKS: Record<LinkRule, MessageKey> = {
	'verified-email': 'sf.link.verified-email',
	ask: 'sf.link.ask',
	new: 'sf.link.new'
};

/** The text of a stored choice, in the language on screen; an id with no text stands for itself. */
function choiceText(texts: Record<string, MessageKey>, id: string): string {
	return id in texts ? t(texts[id]) : id;
}

const NAME_ID_TEXT: Record<string, MessageKey> = {
	persistent: 'sf.sp.nameId.persistent',
	transient: 'sf.sp.nameId.transient',
	email: 'sf.sp.nameId.email',
	unspecified: 'sf.sp.nameId.unspecified'
};
const SP_ATTRS_TEXT: Record<string, MessageKey> = {
	minimal: 'sf.set.minimal',
	standard: 'sf.sp.attrs.standard',
	academic: 'sf.sp.attrs.academic',
	custom: 'sf.sp.attrs.custom'
};
const MIN_AUTH_TEXT: Record<string, MessageKey> = {
	none: 'sf.sp.minAuth.none',
	password: 'sf.sp.minAuth.password',
	aal2: 'sf.sp.minAuth.aal2'
};
const SET_TEXT: Record<string, MessageKey> = {
	'tenant-default': 'sf.set.tenantDefault',
	staff: 'sf.set.staff',
	none: 'sf.set.none',
	minimal: 'sf.set.minimal'
};
const ROLE_TEXT: Record<string, MessageKey> = {
	member: 'sf.extra.role.member',
	editor: 'sf.extra.role.editor',
	admin: 'sf.extra.role.admin'
};

function importedFrom(f: ImportForm): string {
	return f.importMode === 'url'
		? f.metadataUrl
		: f.importMode === 'file'
			? f.fileName
			: t('sf.value.byHand');
}

function consentLabel(id: string): string {
	const statement = CONSENT_STATEMENTS.find((candidate) => candidate.value === id);
	return statement ? t(statement.label) : id;
}

function entityOf(f: ImportForm): string {
	return f.importMode === 'manual' ? f.entityId : dummyMetadata(f.metadataUrl).entityId;
}

/** What the activate part lists back. */
export function reviewRows(a: Answers): ReviewRow[] {
	const kind = kindOf(a);
	const rows: ReviewRow[] = [];
	if (kind === 'rp') {
		rows.push(
			{ label: t('sf.row.kind'), value: t('sf.row.kind.rp') },
			{ label: t('sf.row.name'), value: a.rp.name },
			{ label: t('sf.row.appType'), value: t(APP_TYPES[a.rp.appType]) },
			{
				label: t('sf.part.rp-redirect'),
				value: a.rp.redirectUris.join(', ') || t('sf.value.notSet')
			},
			{ label: t('sf.row.clientAuth'), value: a.rp.authMethod },
			{
				label: t('sf.row.pkce'),
				value: a.rp.pkce ? t('sf.value.required') : t('sf.value.notRequired')
			},
			{ label: t('sf.row.scopes'), value: a.rp.scopes.join(', ') },
			{ label: t('sf.part.rp-info'), value: choiceText(SET_TEXT, a.rp.mappingSet) }
		);
	}
	if (kind === 'sp') {
		rows.push(
			{ label: t('sf.row.kind'), value: t('sf.row.kind.sp') },
			{ label: t('sf.row.importedFrom'), value: importedFrom(a.sp) },
			{ label: t('sf.row.entityId'), value: entityOf(a.sp) },
			{ label: t('sf.row.identifier'), value: choiceText(NAME_ID_TEXT, a.sp.nameIdFormat) },
			{ label: t('sf.row.attributes'), value: choiceText(SP_ATTRS_TEXT, a.sp.attributePreset) },
			{ label: t('sf.row.minAuth'), value: choiceText(MIN_AUTH_TEXT, a.sp.minAuth) },
			{ label: t('sf.row.askConsent'), value: a.sp.consent ? t('sf.value.yes') : t('sf.value.no') },
			{ label: t('sf.row.test'), value: a.sp.tested ? t('sf.value.passed') : t('sf.value.notRun') }
		);
	}
	if (kind === 'op') {
		rows.push(
			{ label: t('sf.row.kind'), value: t('sf.row.kind.op') },
			{ label: t('sf.row.name'), value: a.op.name },
			{ label: t('sf.row.issuer'), value: a.op.issuer || t('sf.value.issuerFromConfig') },
			{ label: t('sf.row.clientId'), value: a.op.clientId },
			{ label: t('sf.part.link'), value: t(LINKS[a.op.link]) },
			{ label: t('sf.row.test'), value: a.op.tested ? t('sf.value.passed') : t('sf.value.notRun') }
		);
	}
	if (kind === 'idp') {
		rows.push(
			{ label: t('sf.row.kind'), value: t('sf.row.kind.idp') },
			{ label: t('sf.row.name'), value: a.idp.name },
			{ label: t('sf.row.importedFrom'), value: importedFrom(a.idp) },
			{ label: t('sf.row.entityId'), value: entityOf(a.idp) },
			{ label: t('sf.part.link'), value: t(LINKS[a.idp.link]) },
			{ label: t('sf.row.test'), value: a.idp.tested ? t('sf.value.passed') : t('sf.value.notRun') }
		);
	}
	if (visibleGroups(a).some((group) => group.id === 'mapping'))
		rows.push({
			label: t('sf.row.mappingSet'),
			value: choiceText(SET_TEXT, a.extras.mappingSet)
		});
	if (visibleGroups(a).some((group) => group.id === 'additional'))
		rows.push({ label: t('sf.group.additional'), value: a.extras.additionalFields.join(', ') });
	if (visibleGroups(a).some((group) => group.id === 'consent'))
		rows.push({
			label: t('sf.group.consent'),
			value: a.extras.consentStatements.map((id) => consentLabel(id)).join(', ')
		});
	if (visibleGroups(a).some((group) => group.id === 'signup'))
		rows.push({
			label: t('sf.group.signup'),
			value: SIGNUP_FLOWS.find((flow) => flow.value === a.extras.signupFlow)?.label ?? ''
		});
	if (visibleGroups(a).some((group) => group.id === 'role'))
		rows.push({ label: t('sf.row.role'), value: choiceText(ROLE_TEXT, a.extras.role) });
	// A value that was not entered is said so, not left blank.
	return rows.map((row) => ({ ...row, value: row.value || t('sf.value.notSet') }));
}

/**
 * Answers filled in for a kind, so a story or the mock can open with something to show.
 * `wizard` is what the wizard itself leaves behind: the parts only the detail screen asks are
 * still unset. `complete` has everything, including the parts the wizard never asked.
 */
export function sampleAnswers(
	kind: ConnectionKind,
	upTo: 'wizard' | 'complete' = 'complete'
): Answers {
	const a = emptyAnswers();
	const full = upTo === 'complete';
	a.direction = KINDS_OF.out.includes(kind) ? 'out' : 'in';
	a.kind = kind;
	if (kind === 'rp') {
		a.rp.name = 'Employee portal';
		if (full) {
			a.rp.redirectUris = ['https://reading.example.com/callback'];
			a.rp.shared = true;
		}
	}
	if (kind === 'sp') {
		Object.assign(a.sp, {
			metadataUrl: 'https://hr.example/saml/metadata',
			fetched: true
		});
		a.sp.shared = full;
		a.sp.tested = full;
	}
	if (kind === 'op' && full) {
		Object.assign(a.op, {
			name: 'Acme Directory',
			issuer: 'https://login.acme.example',
			discovered: true,
			clientId: 'authrim-acme',
			clientSecret: 'dummy-secret',
			shared: true,
			tested: true
		});
	}
	if (kind === 'idp') {
		Object.assign(a.idp, {
			name: 'Corporate sign-in',
			metadataUrl: 'https://idp.corp.example/saml/metadata',
			fetched: true
		});
		a.idp.shared = full;
		a.idp.tested = full;
	}
	// A mapping set is the one thing a service and a SAML provider cannot do without.
	if (full) {
		const { inputs, outputs } = schemaOptions(!KINDS_OF.in.includes(kind));
		a.extras.inputSchema = inputs[0].value;
		a.extras.outputSchema = outputs[0].value;
		a.extras.mappingSet = 'tenant-default';
	}
	return a;
}
