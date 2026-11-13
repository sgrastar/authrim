/**
 * The sign-up flow as the console holds it (`AccountFlowState`) and the sign-up spec it is saved
 * as (ar-lib-core `RegistrationFlowSpec`: a Flow graph with its registration policy). Both ways,
 * so what is saved reads back the same. Consent is the statements the first sign-up screen asks.
 */
import {
	buildRegistrationFlowEditor,
	readRegistrationFlowEditor,
	type RegistrationFlowScreen,
	type RegistrationFlowSpec
} from '@authrim/ar-lib-core/types/registration-flow-graph';
import {
	DEFAULT_REGISTRATION_POLICY,
	type RegistrationExternalEmailCheck,
	type RegistrationPolicy
} from '@authrim/ar-lib-core/types/registration-policy';
import { initialState, titleKey } from './account-flow-model';
import { completionOf, setCompletion } from './completion-mapping';
import { consentStepsOf, consentValueOf } from './consent-field-model';
import { exitKey } from './screen-exits';
import type { AccountFlowState, AccountValue } from './flow-spec';
import { MAX_FLOW_CONSENT_STEPS } from '@authrim/ar-lib-core/types/flow-step-condition';

const TTL: Record<string, number> = { '5m': 300, '10m': 600, '15m': 900 };
const TTL_BACK: Record<number, string> = { 300: '5m', 600: '10m', 900: '15m' };
const EXTERNAL: Record<string, RegistrationExternalEmailCheck> = {
	'no-email': 'no_email',
	unverified: 'unverified',
	'low-trust': 'low_trust'
};
const EXTERNAL_BACK: Record<RegistrationExternalEmailCheck, string> = {
	no_email: 'no-email',
	unverified: 'unverified',
	low_trust: 'low-trust'
};
const EXTRA = /^extra-screen:([1-9][0-9]{0,2})$/u;

function text(value: AccountValue | undefined): string {
	return typeof value === 'string' ? value.trim() : '';
}

function list(value: AccountValue | undefined): string[] {
	return Array.isArray(value) ? value : [];
}

function oneOf<T extends string>(value: string, allowed: readonly T[], otherwise: T): T {
	return (allowed as readonly string[]).includes(value) ? (value as T) : otherwise;
}

/** The domains typed in the field: separated by commas or white space. */
export function domainsOf(value: AccountValue | undefined): string[] {
	return text(value)
		.split(/[\s,]+/u)
		.map((domain) => domain.replace(/^@/u, '').toLowerCase())
		.filter(Boolean);
}

/** The spec a sign-up flow is saved as. */
export function registrationSpecOf(state: AccountFlowState): RegistrationFlowSpec {
	const values = state.values;
	const fallback = DEFAULT_REGISTRATION_POLICY;
	const policy: RegistrationPolicy = {
		duplicate: oneOf(
			text(values['reg.duplicate']),
			['reject', 'login', 'mail'],
			fallback.duplicate
		),
		eligibility: oneOf(
			text(values['reg.policy']),
			['open', 'invite', 'domain'],
			fallback.eligibility
		),
		allowed_domains:
			text(values['reg.policy']) === 'domain' ? domainsOf(values['reg.domains']) : [],
		denied_response: oneOf(
			text(values['reg.denied']),
			['generic', 'reason'],
			fallback.denied_response
		),
		email_check: oneOf(
			text(values['reg.emailCheck']),
			['before', 'later', 'none'],
			fallback.email_check
		),
		external_email_check: list(values['reg.extraWhen']).flatMap((check) =>
			EXTERNAL[check] ? [EXTERNAL[check]] : []
		),
		code_ttl_seconds: TTL[text(values['reg.expiry'])] ?? fallback.code_ttl_seconds,
		completion: completionOf(values, 'reg') ?? { behavior: 'account' }
	};
	const screens: RegistrationFlowScreen[] = state.added.flatMap((id) => {
		const match = EXTRA.exec(id);
		if (!match) return [];
		const n = Number(match[1]);
		const fieldKey = `reg.extraScreen:${n}`;
		const exits: Record<string, string> = {};
		for (const [key, target] of Object.entries(values)) {
			if (!key.startsWith(`${fieldKey}>`) || typeof target !== 'string' || !target) continue;
			const exit = key.slice(fieldKey.length + 1);
			const other = EXTRA.exec(target);
			if (target === 'complete') exits[exit] = 'complete';
			else if (other) exits[exit] = `screen:${other[1]}`;
		}
		const title = text(values[titleKey(`reg-extra-screen:${n}`)]);
		return [{ n, screenKey: text(values[fieldKey]), ...(title ? { title } : {}), exits }];
	});
	const screenTitle = text(values[titleKey('reg-screen')]);
	return {
		profileRef: text(values['reg.methodProfile']) || 'default',
		sessionProfileRef: text(values['reg.sessionProfile']) || 'default',
		screenKey: text(values['reg.screen']),
		...(screenTitle ? { screenTitle } : {}),
		screens,
		policy,
		// The step is added once someone wants consent; taken away, nothing is asked.
		consents: consentStepsOf(state.added.includes('consent'), values['reg.statements'])
	};
}

/**
 * Whether the console's form can hold everything a spec sets: one consent step at most, and no
 * step shown to some people only. Anything more is shown, not saved (saving would drop it).
 */
export function registrationSpecFitsForm(spec: RegistrationFlowSpec): boolean {
	return (
		spec.screens.every((screen) => !screen.when?.length) &&
		spec.consents.length <= 1 &&
		spec.consents.every((step) => !step.when?.length)
	);
}

/** The console's sign-up flow, read from a saved spec (its name and place given apart). */
export function registrationStateOf(
	spec: RegistrationFlowSpec,
	about: { name: string; scope: string }
): AccountFlowState {
	const state = initialState('registration');
	const values = state.values;
	values['reg.name'] = about.name;
	values['reg.scope'] = about.scope;
	values['reg.methodProfile'] = spec.profileRef;
	values['reg.sessionProfile'] = spec.sessionProfileRef;
	values['reg.screen'] = spec.screenKey;
	if (spec.screenTitle) values[titleKey('reg-screen')] = spec.screenTitle;
	const policy = spec.policy;
	values['reg.duplicate'] = policy.duplicate;
	values['reg.policy'] = policy.eligibility;
	if (policy.eligibility === 'domain') values['reg.domains'] = policy.allowed_domains.join(', ');
	values['reg.denied'] = policy.denied_response;
	values['reg.emailCheck'] = policy.email_check;
	values['reg.extraWhen'] = policy.external_email_check.map((check) => EXTERNAL_BACK[check]);
	if (policy.code_ttl_seconds !== null && TTL_BACK[policy.code_ttl_seconds]) {
		values['reg.expiry'] = TTL_BACK[policy.code_ttl_seconds];
	}
	setCompletion(values, policy.completion ?? { behavior: 'account' }, 'reg');
	for (const screen of spec.screens) {
		const id = `extra-screen:${screen.n}`;
		state.added.push(id);
		const fieldKey = `reg.extraScreen:${screen.n}`;
		values[fieldKey] = screen.screenKey;
		if (screen.title) values[titleKey(`reg-extra-screen:${screen.n}`)] = screen.title;
		for (const [exit, target] of Object.entries(screen.exits)) {
			values[exitKey(fieldKey, exit)] =
				target === 'complete' ? 'complete' : target.replace(/^screen:/u, 'extra-screen:');
		}
	}
	const consent = spec.consents[0]?.statements ?? [];
	if (consent.length > 0) {
		state.added.push('consent');
		values['reg.statements'] = consentValueOf(consent);
	}
	return state;
}

/** JSON with its object keys in order, to compare two graphs by what they hold. */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

/** What a graph runs by: its steps (kind and config, in order) and its edges. */
function runShape(editor: unknown): string {
	const graph = (editor ?? {}) as { nodes?: unknown[]; edges?: unknown[] };
	const nodes = (graph.nodes ?? []).map((node) => {
		const { id, type, config } = node as Record<string, unknown>;
		return { id, type, config: config ?? {} };
	});
	const edges = (graph.edges ?? [])
		.map((edge) => {
			const { source, source_handle, target } = edge as Record<string, unknown>;
			return { source, source_handle: source_handle ?? null, target };
		})
		.sort((a, b) => stable(a).localeCompare(stable(b)));
	return stable({ nodes, edges });
}

/**
 * The sign-up Flow every tenant was first given (before this page), as seeded: its steps, their
 * settings and edges exactly. One changed in the Flow editor since is not it.
 */
const SEEDED_SIGN_UP = (() => {
	const outputs = [
		{ id: 'mail_otp', label: 'Email OTP' },
		{ id: 'totp', label: 'Authenticator app' },
		{ id: 'passkey', label: 'Passkey' },
		{ id: 'facebook', label: 'Facebook' }
	];
	return runShape({
		nodes: [
			{ id: 'request', type: 'entry', config: { ui_kind: 'start' } },
			{
				id: 'registration-method',
				type: 'registration',
				config: {
					ui_kind: 'registration',
					authentication_profile_ref: 'default',
					screen_ref: 'registration',
					outputs
				}
			},
			{ id: 'account-create', type: 'account_action', config: { ui_kind: 'account' } },
			{ id: 'output', type: 'complete', config: { ui_kind: 'end' } }
		],
		edges: [
			{ source: 'request', source_handle: 'next', target: 'registration-method' },
			...outputs.map((output) => ({
				source: 'registration-method',
				source_handle: output.id,
				target: 'account-create'
			})),
			{ source: 'account-create', source_handle: 'completed', target: 'output' }
		]
	});
})();

function isSeededSignUp(editor: unknown): boolean {
	return runShape(editor) === SEEDED_SIGN_UP;
}

/**
 * Whether a saved Flow graph is one this page can show and save back without losing anything:
 * one it made (rebuilt from what it reads, it runs the same), or the sign-up every tenant was
 * first given. One with steps or settings made in the Flow editor is shown, not saved.
 */
export function isConsoleShaped(editor: unknown): boolean {
	if (isSeededSignUp(editor)) return true;
	const spec = readRegistrationFlowEditor(editor);
	// More consent steps than the console builds (made in the Flow editor): not its own.
	if (spec === null || spec.consents.length > MAX_FLOW_CONSENT_STEPS) return false;
	return runShape(buildRegistrationFlowEditor(spec)) === runShape(editor);
}
