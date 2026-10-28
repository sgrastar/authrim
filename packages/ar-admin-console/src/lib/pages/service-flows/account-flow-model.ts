import { t } from '$lib/i18n/i18n.svelte';
import type { WizardStep } from '$lib/ui/patterns/WizardSteps.svelte';
import { consentStatements } from './connection-model';
import {
	aboutFields,
	choices,
	emptyFlowState,
	FLOW_PREFIX,
	includes,
	isSyncFlow,
	type AccountField,
	type AccountFlowDef,
	type AccountFlowId,
	type AccountFlowState,
	type AccountGroup,
	type AccountPart,
	type AccountValue,
	type FlowId
} from './flow-spec';
import { SYNC_FLOWS, SYNC_FLOW_IDS, SYNC_PARTS } from './sync-flow-spec';

/**
 * Signing people up and signing them in, as flows of their own. They are not connections
 * (nothing to test against, no other side to register with), but a tenant can have more than one
 * of each: the Login UI it ships with needs one, and so does a separate Login UI or a UI of your
 * own. So each has a name and says where it is used. An app or a provider that lets people sign
 * up through Authrim chooses one of the sign-up flows in its own flow (see `signup-flow` in
 * `connection-model.ts`), so a flow is defined once and used by as many connections as need it.
 * The contract (what Authrim does between its start and its end) is the same everywhere.
 *
 * Like the connection flows, every word is a message key (`af.*`) turned into text when it is
 * asked for, and nothing is chosen for the person: a setting counts as done only once someone
 * chose its values. The settings are described as data (`PARTS`), so one form draws all of them.
 */
export type {
	AccountChoice,
	AccountField,
	AccountFlowDef,
	AccountFlowId,
	AccountFlowState,
	AccountGroup,
	AccountPart,
	AccountValue,
	FlowId,
	SyncFlowId
} from './flow-spec';
export { emptyFlowState, isSyncFlow } from './flow-spec';
export { SYNC_FLOW_IDS } from './sync-flow-spec';

/** The connections the tenant already has, for "sign in through …" (dummy). */
const PROVIDERS = () => [
	{ value: 'acme', label: t('af.provider.acme') },
	{ value: 'corporate', label: t('af.provider.corporate') }
];

const ACCOUNT_PARTS: Record<string, AccountPart> = {
	'reg-about': {
		id: 'reg-about',
		label: 'af.part.about',
		lead: 'af.lead.about',
		note: 'af.note.about',
		fields: aboutFields('registration')
	},
	'login-about': {
		id: 'login-about',
		label: 'af.part.about',
		lead: 'af.lead.about',
		note: 'af.note.about',
		fields: aboutFields('login')
	},
	'reg-fields': {
		id: 'reg-fields',
		label: 'af.part.reg-fields',
		lead: 'af.lead.reg-fields',
		fields: [
			{
				key: 'reg.attributes',
				kind: 'checks',
				label: 'af.field.reg.attributes',
				options: choices('attribute', ['email', 'name', 'phone', 'birthdate']),
				required: true
			},
			{
				key: 'reg.duplicate',
				kind: 'select',
				label: 'af.field.reg.duplicate',
				hint: 'af.hint.reg.duplicate',
				options: choices('duplicate', ['reject', 'login', 'mail']),
				required: true
			}
		]
	},
	'reg-eligibility': {
		id: 'reg-eligibility',
		label: 'af.part.reg-eligibility',
		lead: 'af.lead.reg-eligibility',
		fields: [
			{
				key: 'reg.policy',
				kind: 'select',
				label: 'af.field.reg.policy',
				options: choices('eligibility', ['open', 'invite', 'domain']),
				required: true
			},
			{
				key: 'reg.denied',
				kind: 'select',
				label: 'af.field.reg.denied',
				options: choices('denied', ['generic', 'reason'])
			}
		]
	},
	'reg-methods': {
		id: 'reg-methods',
		label: 'af.part.reg-methods',
		lead: 'af.lead.reg-methods',
		fields: [
			{
				key: 'reg.methods',
				kind: 'checks',
				label: 'af.field.methods',
				options: choices('method', ['passkey', 'password', 'external']),
				required: true
			},
			{
				key: 'reg.provider',
				kind: 'select',
				label: 'af.field.provider',
				hint: 'af.hint.provider',
				options: PROVIDERS,
				required: true,
				showWhen: includes('reg.methods', 'external')
			}
		]
	},
	'reg-verification': {
		id: 'reg-verification',
		label: 'af.part.reg-verification',
		lead: 'af.lead.reg-verification',
		fields: [
			{
				key: 'reg.emailCheck',
				kind: 'select',
				label: 'af.field.reg.emailCheck',
				options: choices('emailCheck', ['before', 'later', 'none']),
				required: true
			},
			{
				key: 'reg.expiry',
				kind: 'select',
				label: 'af.field.reg.expiry',
				options: choices('expiry', ['15m', '1h', '24h']),
				required: true,
				showWhen: (values) =>
					values['reg.emailCheck'] === 'before' || values['reg.emailCheck'] === 'later'
			}
		]
	},
	'reg-extra-check': {
		id: 'reg-extra-check',
		label: 'af.part.reg-extra-check',
		lead: 'af.lead.reg-extra-check',
		note: 'af.note.reg-extra-check',
		fields: [
			{
				key: 'reg.extraWhen',
				kind: 'checks',
				label: 'af.field.reg.extraWhen',
				options: choices('extraWhen', ['no-email', 'unverified', 'low-trust']),
				required: true
			},
			{
				key: 'reg.extraMethod',
				kind: 'select',
				label: 'af.field.reg.extraMethod',
				hint: 'af.hint.reg.extraMethod',
				options: choices('extraMethod', ['email-code', 'sms-code']),
				required: true
			},
			{
				key: 'reg.extraExpiry',
				kind: 'select',
				label: 'af.field.reg.extraExpiry',
				options: choices('codeExpiry', ['10m', '30m', '1h']),
				required: true
			}
		]
	},
	'reg-statements': {
		id: 'reg-statements',
		label: 'af.part.reg-statements',
		lead: 'af.lead.reg-statements',
		note: 'af.note.reg-statements',
		fields: [
			{
				key: 'reg.statements',
				kind: 'checks',
				label: 'af.field.reg.statements',
				options: consentStatements,
				required: true
			}
		]
	},
	'reg-policy': {
		id: 'reg-policy',
		label: 'af.part.reg-policy',
		lead: 'af.lead.reg-policy',
		note: 'af.note.reg-policy',
		fields: [
			{
				key: 'reg.consentWhen',
				kind: 'select',
				label: 'af.field.reg.consentWhen',
				options: choices('consentWhen', ['signup', 'version']),
				required: true
			}
		]
	},
	'reg-account': {
		id: 'reg-account',
		label: 'af.part.reg-account',
		lead: 'af.lead.reg-account',
		note: 'af.note.reg-account',
		fields: [
			{
				key: 'reg.state',
				kind: 'select',
				label: 'af.field.reg.state',
				options: choices('accountState', ['active', 'pending']),
				required: true
			}
		]
	},
	'reg-result': {
		id: 'reg-result',
		label: 'af.part.reg-result',
		lead: 'af.lead.reg-result',
		fields: [
			{
				key: 'reg.after',
				kind: 'select',
				label: 'af.field.reg.after',
				options: choices('after', ['login', 'session']),
				required: true
			},
			{
				key: 'reg.interrupted',
				kind: 'select',
				label: 'af.field.reg.interrupted',
				options: choices('interrupted', ['resume', 'restart'])
			}
		]
	},
	'login-methods': {
		id: 'login-methods',
		label: 'af.part.login-methods',
		lead: 'af.lead.login-methods',
		fields: [
			{
				key: 'login.methods',
				kind: 'checks',
				label: 'af.field.methods',
				options: choices('method', ['passkey', 'password', 'otp', 'external']),
				required: true
			},
			{
				key: 'login.provider',
				kind: 'select',
				label: 'af.field.provider',
				hint: 'af.hint.provider',
				options: PROVIDERS,
				required: true,
				showWhen: includes('login.methods', 'external')
			}
		]
	},
	'login-validation': {
		id: 'login-validation',
		label: 'af.part.login-validation',
		lead: 'af.lead.login-validation',
		note: 'af.note.login-validation',
		fields: [
			{
				key: 'login.failures',
				kind: 'select',
				label: 'af.field.login.failures',
				options: choices('failures', ['delay', 'lock', 'none']),
				required: true
			},
			{
				key: 'login.unregistered',
				kind: 'select',
				label: 'af.field.login.unregistered',
				hint: 'af.hint.login.unregistered',
				options: choices('unregistered', ['guide', 'generic']),
				required: true
			}
		]
	},
	'login-conditions': {
		id: 'login-conditions',
		label: 'af.part.login-conditions',
		lead: 'af.lead.login-conditions',
		fields: [
			{
				key: 'login.stepUpWhen',
				kind: 'select',
				label: 'af.field.login.stepUpWhen',
				options: choices('stepUpWhen', ['always', 'risk', 'sensitive']),
				required: true
			},
			{
				key: 'login.stepUpFactor',
				kind: 'select',
				label: 'af.field.login.stepUpFactor',
				options: choices('method', ['passkey', 'otp']),
				required: true
			},
			{
				key: 'login.stepUpUnavailable',
				kind: 'select',
				label: 'af.field.login.stepUpUnavailable',
				options: choices('stepUpUnavailable', ['deny', 'enroll'])
			}
		]
	},
	'login-session': {
		id: 'login-session',
		label: 'af.part.login-session',
		lead: 'af.lead.login-session',
		fields: [
			{
				key: 'login.lifetime',
				kind: 'select',
				label: 'af.field.login.lifetime',
				options: choices('lifetime', ['8h', '24h', '7d']),
				required: true
			},
			{
				key: 'login.reauth',
				kind: 'select',
				label: 'af.field.login.reauth',
				options: choices('reauth', ['idle', 'none'])
			}
		]
	},
	'login-return': {
		id: 'login-return',
		label: 'af.part.login-return',
		lead: 'af.lead.login-return',
		note: 'af.note.login-return',
		fields: [
			{
				key: 'login.failure',
				kind: 'select',
				label: 'af.field.login.failure',
				options: choices('failure', ['error', 'stay']),
				required: true
			}
		]
	}
};

/** Every setting of every flow, by part id. */
export const PARTS: Record<string, AccountPart> = { ...ACCOUNT_PARTS, ...SYNC_PARTS };

export const FLOWS: Record<FlowId, AccountFlowDef> = {
	registration: {
		id: 'registration',
		title: 'af.flow.registration.title',
		subtitle: 'af.flow.registration.subtitle',
		summary: 'af.flow.registration.summary',
		start: { title: 'af.flow.registration.start', detail: 'af.flow.ui' },
		end: { title: 'af.flow.registration.end', detail: 'af.flow.registration.endDetail' },
		groups: [
			{ id: 'input', label: 'af.group.input', parts: ['reg-fields', 'reg-eligibility'] },
			{ id: 'identity', label: 'af.group.identity', parts: ['reg-methods', 'reg-verification'] },
			{
				id: 'extra-check',
				label: 'af.group.extraCheck',
				parts: ['reg-extra-check'],
				optional: true
			},
			{
				id: 'consent',
				label: 'af.group.regConsent',
				parts: ['reg-statements', 'reg-policy'],
				optional: true
			},
			{ id: 'complete', label: 'af.group.complete', parts: ['reg-account', 'reg-result'] }
		]
	},
	login: {
		id: 'login',
		title: 'af.flow.login.title',
		subtitle: 'af.flow.login.subtitle',
		summary: 'af.flow.login.summary',
		start: { title: 'af.flow.login.start', detail: 'af.flow.ui' },
		end: { title: 'af.flow.login.end', detail: 'af.flow.login.endDetail' },
		groups: [
			{
				id: 'authenticate',
				label: 'af.group.authenticate',
				parts: ['login-methods', 'login-validation']
			},
			{
				id: 'stepup',
				label: 'af.group.stepUp',
				parts: ['login-conditions'],
				optional: true
			},
			{ id: 'finish', label: 'af.group.finish', parts: ['login-session', 'login-return'] }
		]
	},
	...SYNC_FLOWS
};

/** The flows that sign people up and in. */
export const ACCOUNT_FLOW_IDS: readonly AccountFlowId[] = ['registration', 'login'];
/** Every flow: sign-up and sign-in, then the user sync flows. */
export const ALL_FLOW_IDS: readonly FlowId[] = [...ACCOUNT_FLOW_IDS, ...SYNC_FLOW_IDS];

/** Every setting of a step of a flow, flat (the flow's own settings, see `aboutPart`, are not one). */
export function partsOf(flow: FlowId): string[] {
	return FLOWS[flow].groups.flatMap((group) => group.parts);
}

export function partLabel(partId: string): string {
	return t(PARTS[partId].label);
}

export function groupLabel(group: AccountGroup): string {
	return t(group.label);
}

/** The steps as the flow is now: the fixed ones and the optional ones that were added. */
export function visibleGroups(flow: FlowId, state: AccountFlowState): AccountGroup[] {
	return FLOWS[flow].groups.filter((group) => !group.optional || state.added.includes(group.id));
}

function hasValue(value: AccountValue | undefined): boolean {
	return Array.isArray(value) ? value.length > 0 : value !== undefined && value.trim() !== '';
}

/** The fields of a setting that apply to what has been chosen so far. */
export function shownFields(partId: string, state: AccountFlowState): AccountField[] {
	return PARTS[partId].fields.filter((field) => !field.showWhen || field.showWhen(state.values));
}

export type PartState = 'done' | 'required' | 'todo';

/**
 * A setting is done once every field it needs has a value. Until then it is required, in a step
 * the flow cannot do without, and otherwise just still to do.
 */
export function partState(partId: string, flow: FlowId, state: AccountFlowState): PartState {
	const complete = shownFields(partId, state)
		.filter((field) => field.required)
		.every((field) => hasValue(state.values[field.key]));
	if (complete) return 'done';
	const group = FLOWS[flow].groups.find((candidate) => candidate.parts.includes(partId));
	return group?.optional ? 'todo' : 'required';
}

export function groupState(
	group: AccountGroup,
	flow: FlowId,
	state: AccountFlowState
): 'done' | 'partial' | 'todo' | 'required' {
	const states = group.parts.map((id) => partState(id, flow, state));
	if (states.includes('required')) return 'required';
	if (states.every((value) => value === 'done')) return 'done';
	return states.includes('done') ? 'partial' : 'todo';
}

/** The settings still to be done, required ones first. */
export function stillToDo(
	flow: FlowId,
	state: AccountFlowState
): { id: string; label: string; state: PartState }[] {
	// The flow's own settings (name, place) come first: they are not a step of the flow.
	const open = [ABOUT_PART[flow], ...visibleGroups(flow, state).flatMap((group) => group.parts)]
		.map((id) => ({ id, label: partLabel(id), state: partState(id, flow, state) }))
		.filter((part) => part.state !== 'done');
	return [
		...open.filter((part) => part.state === 'required'),
		...open.filter((part) => part.state !== 'required')
	];
}

/** The flow can be used once none of its settings is still required. */
export function isReady(flow: FlowId, state: AccountFlowState): boolean {
	return stillToDo(flow, state).every((part) => part.state !== 'required');
}

export interface SummaryRow {
	label: string;
	value: string;
}

/** What was chosen, field by field, for the overview; a field with no value says so. */
export function summaryRows(flow: FlowId, state: AccountFlowState): SummaryRow[] {
	return visibleGroups(flow, state)
		.flatMap((group) => group.parts)
		.flatMap((partId) => shownFields(partId, state))
		.map((field) => {
			const chosen = state.values[field.key];
			const options = field.options();
			const texts = (Array.isArray(chosen) ? chosen : chosen ? [chosen] : []).map(
				(value) => options.find((option) => option.value === value)?.label ?? value
			);
			return { label: t(field.label), value: texts.join(', ') || t('sf.value.notSet') };
		});
}

/** A flow with every required setting chosen (and, with `full`, the optional steps too). */
export function sampleState(flow: FlowId, full = false): AccountFlowState {
	const state = emptyFlowState();
	if (full) state.added = FLOWS[flow].groups.filter((g) => g.optional).map((group) => group.id);
	const wanted = FLOWS[flow].groups.filter((group) => full || !group.optional);
	for (const partId of [ABOUT_PART[flow], ...wanted.flatMap((group) => group.parts)]) {
		for (const field of PARTS[partId].fields) {
			if (!field.required && !full) continue;
			// A field that is not shown for what was chosen so far is left unset, as it would be by hand.
			if (field.showWhen && !field.showWhen(state.values)) continue;
			if (field.kind === 'text') {
				state.values[field.key] = 'Sample flow';
				continue;
			}
			const first = field.options()[0]?.value;
			if (first === undefined) continue;
			state.values[field.key] = field.kind === 'checks' ? [first] : first;
		}
	}
	return state;
}

const NAME_KEY = Object.fromEntries(
	Object.entries(FLOW_PREFIX).map(([flow, prefix]) => [flow, `${prefix}.name`])
) as Record<FlowId, string>;
const ABOUT_PART = Object.fromEntries(
	Object.entries(FLOW_PREFIX).map(([flow, prefix]) => [flow, `${prefix}-about`])
) as Record<FlowId, string>;

/** The setting that holds the flow's name and where it is used. */
export function aboutPart(flow: FlowId): string {
	return ABOUT_PART[flow];
}

/** The name the flow goes by; until it has one, what kind of flow it is. */
export function flowName(flow: FlowId, state: AccountFlowState): string {
	const name = state.values[NAME_KEY[flow]];
	return typeof name === 'string' && name.trim() !== '' ? name : t(FLOWS[flow].title);
}

/**
 * A flow that has its name and its second setting (where it is used, or the other system) and
 * nothing else yet: what the wizard leaves behind.
 */
export function aboutState(flow: FlowId, name: string, second: string): AccountFlowState {
	const state = emptyFlowState();
	const prefix = FLOW_PREFIX[flow];
	state.values[`${prefix}.name`] = name;
	state.values[`${prefix}.${isSyncFlow(flow) ? 'partner' : 'scope'}`] = second;
	return state;
}

/** The wizard's steps for a table-defined flow: the two questions, then its name and the rest. */
export function accountWizardSteps(flow: FlowId | ''): WizardStep[] {
	const steps = [
		{ id: 'where', label: t('sf.part.where') },
		{ id: 'kind', label: t('sf.part.kind') }
	];
	return flow ? [...steps, { id: 'account-about', label: partLabel(ABOUT_PART[flow]) }] : steps;
}

/** Whether the person may leave a step of the wizard for a sign-up or sign-in flow. */
export function canProceedAccount(
	stepId: string,
	flow: FlowId | '',
	state: AccountFlowState
): boolean {
	if (stepId === 'kind') return flow !== '';
	if (stepId === 'account-about' && flow)
		return partState(ABOUT_PART[flow], flow, state) === 'done';
	return true;
}
