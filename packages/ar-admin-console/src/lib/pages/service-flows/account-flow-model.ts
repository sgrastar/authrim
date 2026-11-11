import { t } from '#lib/i18n/i18n.svelte.js';
import type { WizardStep } from '#lib/ui/patterns/WizardSteps.svelte';
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
		fields: aboutFields('registration')
	},
	'login-about': {
		id: 'login-about',
		label: 'af.part.about',
		fields: aboutFields('login')
	},
	'reg-general': {
		id: 'reg-general',
		label: 'af.part.reg-general',
		fields: [
			{
				key: 'reg.duplicate',
				kind: 'select',
				label: 'af.field.reg.duplicate',
				hint: 'af.hint.reg.duplicate',
				options: choices('duplicate', ['reject', 'login', 'mail']),
				required: true,
				// Not telling others whether an address is registered.
				initial: 'mail'
			},
			{
				key: 'reg.policy',
				kind: 'select',
				label: 'af.field.reg.policy',
				options: choices('eligibility', ['open', 'invite', 'domain']),
				required: true,
				initial: 'open'
			},
			{
				// Who may sign up by address: the domains, one or more.
				key: 'reg.domains',
				kind: 'text',
				label: 'af.field.reg.domains',
				hint: 'af.hint.reg.domains',
				options: () => [],
				required: true,
				showWhen: (values) => values['reg.policy'] === 'domain'
			},
			{
				key: 'reg.denied',
				kind: 'select',
				label: 'af.field.reg.denied',
				options: choices('denied', ['generic', 'reason']),
				// Not telling why is the safer answer.
				initial: 'generic'
			}
		]
	},
	'reg-methods': {
		id: 'reg-methods',
		label: 'af.part.reg-methods',
		lead: 'af.lead.reg-methods',
		fields: [
			{
				key: 'reg.methodProfile',
				kind: 'profile',
				label: 'af.field.reg.methodProfile',
				options: () => [],
				required: true,
				// Every tenant has its default profile.
				initial: 'default'
			}
		]
	},
	'reg-extra-screen': {
		id: 'reg-extra-screen',
		label: 'af.part.reg-extra-screen',
		renamable: true,
		fields: [
			{
				key: 'reg.extraScreen',
				kind: 'screen',
				// Asking for more at sign-up: another sign-up screen, or a screen of one's own.
				screenKinds: ['registration', 'custom'],
				label: 'af.field.reg.extraScreen',
				options: () => [],
				required: true
			}
		]
	},
	'reg-screen': {
		id: 'reg-screen',
		label: 'af.part.reg-screen',
		renamable: true,
		lead: 'af.lead.reg-screen',
		fields: [
			{
				key: 'reg.screen',
				kind: 'screen',
				screenKinds: ['registration'],
				label: 'af.field.reg.screen',
				options: () => [],
				required: true,
				// The sign-up screen every tenant is made with, so a new one can sign people up.
				initial: 'registration'
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
				required: true,
				// What sign-up by email code does today.
				initial: 'before'
			},
			{
				// Someone from another provider may arrive with no address, or one that cannot be
				// trusted: they are checked by email too, whatever is chosen above.
				key: 'reg.extraWhen',
				kind: 'checks',
				label: 'af.field.reg.extraWhen',
				hint: 'af.hint.reg.extraWhen',
				options: choices('extraWhen', ['no-email', 'unverified', 'low-trust']),
				initial: ['no-email', 'unverified']
			},
			{
				key: 'reg.expiry',
				kind: 'select',
				label: 'af.field.reg.expiry',
				hint: 'af.hint.reg.expiry',
				options: choices('expiry', ['5m', '10m', '15m']),
				required: true,
				showWhen: (values) =>
					values['reg.emailCheck'] === 'before' ||
					values['reg.emailCheck'] === 'later' ||
					(Array.isArray(values['reg.extraWhen']) && values['reg.extraWhen'].length > 0),
				// The shortest: the safer one.
				initial: '5m'
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
	'reg-result': {
		id: 'reg-result',
		label: 'af.part.reg-result',
		lead: 'af.lead.reg-result',
		note: 'af.note.reg-result',
		// The Login UI's own post-login setting (`login-entry.post_login_*`, `self-service.
		// account_page_*`, `service-site.fallback_enabled`), as the current Admin UI sets it.
		fields: [
			{
				key: 'reg.after',
				kind: 'select',
				label: 'af.field.reg.after',
				options: choices('after', [
					'account',
					'home',
					'custom_url',
					'app_login',
					'saml_login',
					'service_site'
				]),
				required: true,
				initial: 'account'
			},
			{
				key: 'reg.redirectUrl',
				kind: 'text',
				label: 'af.field.reg.redirectUrl',
				hint: 'af.hint.reg.redirectUrl',
				options: () => [],
				required: true,
				showWhen: (values) => values['reg.after'] === 'custom_url'
			},
			{
				key: 'reg.servicePath',
				kind: 'text',
				label: 'af.field.reg.servicePath',
				hint: 'af.hint.reg.servicePath',
				options: () => [],
				required: true,
				showWhen: (values) => values['reg.after'] === 'service_site'
			},
			{
				key: 'reg.appClient',
				kind: 'client',
				label: 'af.field.reg.appClient',
				hint: 'af.hint.reg.appClient',
				options: () => [],
				required: true,
				showWhen: (values) => values['reg.after'] === 'app_login'
			},
			{
				key: 'reg.appRedirectUri',
				kind: 'client-redirect',
				clientKey: 'reg.appClient',
				label: 'af.field.reg.appRedirectUri',
				hint: 'af.hint.reg.appRedirectUri',
				options: () => [],
				required: true,
				showWhen: (values) => values['reg.after'] === 'app_login'
			},
			{
				key: 'reg.appScope',
				kind: 'text',
				label: 'af.field.reg.appScope',
				hint: 'af.hint.reg.appScope',
				options: () => [],
				required: true,
				initial: 'openid profile email',
				showWhen: (values) => values['reg.after'] === 'app_login'
			},
			{
				key: 'reg.appReturnTo',
				kind: 'text',
				label: 'af.field.reg.appReturnTo',
				hint: 'af.hint.reg.appReturnTo',
				options: () => [],
				showWhen: (values) => values['reg.after'] === 'app_login'
			},
			// `login-entry.saml_login_*`: an IdP-initiated sign-in to the provider.
			{
				key: 'reg.samlSp',
				kind: 'saml-sp',
				label: 'af.field.reg.samlSp',
				hint: 'af.hint.reg.samlSp',
				options: () => [],
				required: true,
				showWhen: (values) => values['reg.after'] === 'saml_login'
			},
			{
				key: 'reg.samlRelayState',
				kind: 'text',
				label: 'af.field.reg.samlRelayState',
				hint: 'af.hint.reg.samlRelayState',
				options: () => [],
				showWhen: (values) => values['reg.after'] === 'saml_login'
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
		general: ['reg-general', 'reg-verification'],
		groups: [
			{ id: 'identity', label: 'af.group.identity', parts: ['reg-methods'] },
			{ id: 'screen', label: 'af.group.screen', parts: ['reg-screen'] },
			{
				id: 'extra-screen',
				// Another screen: the same step as the first, its setting numbered on from it.
				label: 'af.group.screen',
				parts: ['reg-extra-screen'],
				optional: true,
				// Ask for everything on one more screen, or split it over two or three.
				repeatable: 5
			},
			{
				id: 'consent',
				label: 'af.group.regConsent',
				parts: ['reg-statements', 'reg-policy'],
				optional: true
			},
			{ id: 'complete', label: 'af.group.complete', parts: ['reg-result'] }
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

/**
 * Every setting of a step of a flow, flat (the flow's own settings, see `aboutPart`, and its
 * general settings, see `generalParts`, are not one).
 */
export function partsOf(flow: FlowId): string[] {
	return FLOWS[flow].groups.flatMap((group) => group.parts);
}

/** One step of a repeatable group (`<group>:<n>`, its parts `<part>:<n>`). */
const INSTANCE = /^(.+):(\d+)$/u;

/** The group and its number, for a step of a repeatable group; null for any other id. */
function instanceOf(id: string): { base: string; n: number } | null {
	const match = INSTANCE.exec(id);
	return match ? { base: match[1], n: Number(match[2]) } : null;
}

/** A setting, by id: a step of a repeatable group has its part's fields under keys of its own. */
export function partDef(partId: string): AccountPart {
	const own = PARTS[partId];
	if (own) return own;
	const instance = instanceOf(partId);
	const base = instance ? PARTS[instance.base] : undefined;
	if (!instance || !base) throw new Error(`Unknown setting ${partId}`);
	return {
		...base,
		id: partId,
		fields: base.fields.map((field) => ({ ...field, key: `${field.key}:${instance.n}` }))
	};
}

/** A step of the flow, by id: a group, or one step of a repeatable group (its parts numbered). */
export function groupDef(flow: FlowId, id: string): AccountGroup | undefined {
	const groups = FLOWS[flow].groups;
	const own = groups.find((group) => group.id === id);
	if (own) return own;
	const instance = instanceOf(id);
	const base = instance
		? groups.find((group) => group.id === instance.base && group.repeatable)
		: undefined;
	if (!instance || !base) return undefined;
	return { ...base, id, parts: base.parts.map((part) => `${part}:${instance.n}`) };
}

/** The steps of a repeatable group the flow has now, in the order they were added. */
function instancesOf(group: AccountGroup, state: AccountFlowState): string[] {
	return state.added
		.filter((id) => instanceOf(id)?.base === group.id)
		.sort((a, b) => (instanceOf(a)?.n ?? 0) - (instanceOf(b)?.n ?? 0));
}

/**
 * Every step the flow can have now, in running order, for the flow's "+": a repeatable group's
 * steps, then the next one it can add (until it has as many as it may).
 */
export function stepOrder(flow: FlowId, state: AccountFlowState): string[] {
	return FLOWS[flow].groups.flatMap((group) => {
		if (!group.repeatable) return [group.id];
		const have = instancesOf(group, state);
		const used = have.map((id) => instanceOf(id)?.n ?? 0);
		const next = `${group.id}:${Math.max(0, ...used) + 1}`;
		return have.length < group.repeatable ? [...have, next] : have;
	});
}

/**
 * A setting's default name. One of a repeatable step is numbered on from the step before the
 * group (`{n}`: the first more screen is the second screen).
 */
export function partLabel(partId: string): string {
	const instance = instanceOf(partId);
	return t(partDef(partId).label, instance ? { n: instance.n + 1 } : undefined);
}

/** Where a setting's own title is kept among the flow's values. */
export function titleKey(partId: string): string {
	return `title:${partId}`;
}

/** A setting's title: the one given to it, else its default name. */
export function partTitle(partId: string, state: AccountFlowState): string {
	const given = state.values[titleKey(partId)];
	return typeof given === 'string' && given.trim() ? given : partLabel(partId);
}

/** A step's name (the same for every step of a repeatable group: its settings tell them apart). */
export function groupLabel(group: AccountGroup): string {
	return t(group.label);
}

/** The steps as the flow is now: the fixed ones and the optional ones that were added. */
export function visibleGroups(flow: FlowId, state: AccountFlowState): AccountGroup[] {
	return FLOWS[flow].groups.flatMap((group) => {
		if (group.repeatable) {
			return instancesOf(group, state).flatMap((id) => groupDef(flow, id) ?? []);
		}
		return !group.optional || state.added.includes(group.id) ? [group] : [];
	});
}

/** A list counts as set once it has an entry and none is left unchosen. */
function hasValue(value: AccountValue | undefined): boolean {
	return Array.isArray(value)
		? value.length > 0 && value.every((entry) => entry.trim() !== '')
		: value !== undefined && value.trim() !== '';
}

/** The fields of a setting that apply to what has been chosen so far. */
export function shownFields(partId: string, state: AccountFlowState): AccountField[] {
	// A step of a repeatable group asks what its group asks, of its own values.
	const part = partDef(partId);
	const instance = PARTS[partId] ? null : instanceOf(partId);
	const own = (values: Record<string, AccountValue>) =>
		instance
			? Object.fromEntries(
					Object.entries(values).flatMap(([key, value]) => {
						const match = instanceOf(key);
						return match?.n === instance.n ? [[match.base, value]] : [];
					})
				)
			: values;
	return part.fields.filter((field) => !field.showWhen || field.showWhen(own(state.values)));
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
	const group = FLOWS[flow].groups.find(
		(candidate) =>
			candidate.parts.includes(partId) ||
			(candidate.repeatable && candidate.parts.includes(instanceOf(partId)?.base ?? ''))
	);
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
	// The flow's own settings (name, place) and its general settings come first: they are not a
	// step of the flow.
	const open = [...ownParts(flow), ...visibleGroups(flow, state).flatMap((group) => group.parts)]
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
	return [...generalParts(flow), ...visibleGroups(flow, state).flatMap((group) => group.parts)]
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
	if (full) {
		state.added = FLOWS[flow].groups
			.filter((g) => g.optional)
			.map((group) => (group.repeatable ? `${group.id}:1` : group.id));
	}
	const wanted = visibleGroups(flow, state);
	for (const partId of [...ownParts(flow), ...wanted.flatMap((group) => group.parts)]) {
		for (const field of partDef(partId).fields) {
			if (!field.required && !full) continue;
			// A field that is not shown for what was chosen so far is left unset, as it would be by hand.
			if (field.showWhen && !field.showWhen(state.values)) continue;
			if (field.initial !== undefined) {
				state.values[field.key] = structuredClone(field.initial);
				continue;
			}
			if (field.kind === 'text') {
				state.values[field.key] = 'Sample flow';
				continue;
			}
			if (field.kind === 'screen') {
				// The mock's own sign-up screen, by its key (see `MOCK_SCREENS`).
				state.values[field.key] = 'registration_custom';
				continue;
			}
			if (field.kind === 'saml-sp') {
				// The mock's own enabled provider (see `MOCK_SAML_SERVICE_PROVIDERS`).
				state.values[field.key] = 'https://lms.example.edu/shibboleth';
				continue;
			}
			if (field.kind === 'client' || field.kind === 'client-redirect') {
				// The mock's own app and its first redirect URI (see `MOCK_CLIENTS`).
				state.values[field.key] =
					field.kind === 'client' ? 'client_member_app' : 'https://app.example.com/callback';
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

/** A new flow: unset, but for the settings that start with a value (see `AccountField.initial`). */
export function initialState(flow: FlowId): AccountFlowState {
	const state = emptyFlowState();
	for (const partId of [...ownParts(flow), ...partsOf(flow)])
		for (const field of PARTS[partId].fields)
			if (field.initial !== undefined) state.values[field.key] = structuredClone(field.initial);
	return state;
}

/** The setting that holds the flow's name and where it is used. */
export function aboutPart(flow: FlowId): string {
	return ABOUT_PART[flow];
}

/**
 * The settings that apply to the whole flow rather than to one of its steps, shown in a frame of
 * their own in place of the overview; empty when the flow has none.
 */
export function generalParts(flow: FlowId): readonly string[] {
	return FLOWS[flow].general ?? [];
}

/** The settings of the flow that are not a step of it: its name and place, then its general ones. */
function ownParts(flow: FlowId): string[] {
	return [ABOUT_PART[flow], ...generalParts(flow)];
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
	const state = initialState(flow);
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
