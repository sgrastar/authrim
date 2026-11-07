/**
 * The lite Login UI's Flow driver: the same Flow runtime the SPA drives, driven from the server.
 *
 * The SPA keeps its Flow (interaction ID, contract hash and signature) in sessionStorage; here it
 * is kept in the lite transaction (`data.flow`). The contract itself (with its screens, possibly
 * larger than a transaction holds) is not kept: a page asks for it again with a resume `start`,
 * which also signs it again (the new hash and signature replace the kept ones).
 *
 * A page view (a GET) only starts or resumes the Flow and draws the step it is on. It never
 * submits a step (plan §14): a step the SPA would submit on its own (not rendered, a completion,
 * an account action that asks nothing) is drawn as a one-click "Continue" form, and the
 * submitting happens in that verified form post.
 */
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import { runtimeAutoSubmitHandle } from '#lib/authrim/flow-runtime-steps.js';
import {
	LITE_AUTH_METHODS,
	LITE_FLOW_COMPONENTS,
	LITE_SCREEN_BLOCK_TYPES
} from '@authrim/ar-lib-core/services/lite-compatibility';
import type { LiteBackendClient } from './backend-client';
import {
	runtimeAllowsAuthenticationHandle,
	runtimeAllowsExternalProvider
} from '#lib/authrim/runtime-auth-handles.js';
import {
	authWidgetMethod,
	isDisplayConditionMet,
	type RuntimeScreenAuthMethod
} from '#lib/runtime-screen-methods.js';

/** The tenant's sign-in methods, as the authentication methods answer gives them. */
export interface LiteTenantMethods {
	passkey?: { enabled?: boolean; loginEnabled?: boolean };
	emailCode?: { enabled?: boolean; loginEnabled?: boolean };
	totp?: { enabled?: boolean; loginEnabled?: boolean };
	directoryPassword?: { enabled?: boolean };
	external?: {
		enabled?: boolean;
		providers?: Array<{ enabled?: boolean; loginEnabled?: boolean } & Record<string, unknown>>;
	};
	guest?: { enabled?: boolean };
}

/**
 * Which sign-in methods a step really offers: on for the tenant and allowed by the step's output
 * handles. The rule the SPA draws with (login +page.svelte `runtimeMethodAvailability`), so a
 * block for a method that is off (the default screens list them all) is left out, not refused.
 */
export function liteMethodAvailability(
	methods: LiteTenantMethods | null | undefined,
	step: FlowRuntimeStep | null
): (method: RuntimeScreenAuthMethod) => boolean {
	const on = (value?: { enabled?: boolean; loginEnabled?: boolean }) =>
		value ? (value.loginEnabled ?? value.enabled) === true : false;
	const allows = (handle: string, aliases: string[] = []) =>
		runtimeAllowsAuthenticationHandle(step, handle, aliases);
	const providers = (methods?.external?.providers ?? []).filter(
		(provider) =>
			(provider.loginEnabled ?? provider.enabled !== false) &&
			runtimeAllowsExternalProvider(step, provider as never)
	);
	const available: Record<RuntimeScreenAuthMethod, boolean> = {
		passkey: on(methods?.passkey) && allows('passkey'),
		mail_otp: on(methods?.emailCode) && allows('mail_otp', ['email_code']),
		totp: on(methods?.totp) && allows('totp', ['otp']),
		directory_password:
			methods?.directoryPassword?.enabled === true && allows('directory_password', ['password']),
		external_idp: methods?.external?.enabled === true && providers.length > 0,
		mail_otp_totp: false
	};
	available.mail_otp_totp = available.mail_otp || available.totp;
	return (method) => available[method];
}

/** A provider the lite page draws a button for. */
export interface LiteSocialProvider {
	/**
	 * The ID the authentication methods answer gives (its slug, when it has one): the Flow's
	 * handle, and what the start grant and ar-bridge's start name (which takes an ID or a slug).
	 */
	id: string;
	name: string;
	buttonText: string | null;
	/**
	 * How it is started: by redirect (ar-bridge), or as a SAML IdP (ar-saml's SP start), whose ID
	 * the authentication methods answer gives as `saml:<IdP ID>`.
	 */
	startMode: 'oauth_redirect' | 'saml_sp';
}

/**
 * The providers a step offers: on for sign-in, and allowed by the step's handles (the SPA's
 * `visibleExternalProviders`). A SAML IdP is one whose ID is `saml:<IdP ID>`.
 */
export function liteSocialProviders(
	methods: LiteTenantMethods | null | undefined,
	step: FlowRuntimeStep | null
): { providers: LiteSocialProvider[] } {
	if (methods?.external?.enabled !== true) return { providers: [] };
	const providers: LiteSocialProvider[] = [];
	const text = (value: unknown, max: number) =>
		typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
	for (const raw of methods.external.providers ?? []) {
		if (!isRecord(raw)) continue;
		const id = text(raw.id, 128);
		if (!id) continue;
		if (!((raw.loginEnabled as boolean | undefined) ?? raw.enabled !== false)) continue;
		if (!runtimeAllowsExternalProvider(step, raw as never)) continue;
		const startMode = raw.startMode === 'saml_sp' ? 'saml_sp' : 'oauth_redirect';
		// A SAML IdP is started by its own ID, which its listed ID carries.
		if (startMode === 'saml_sp' && !/^saml:[^/?#\\]+$/u.test(id)) continue;
		providers.push({
			id,
			startMode,
			name: text(raw.name, 200) ?? id,
			buttonText: text(raw.buttonText, 200)
		});
	}
	return { providers };
}

/** The Flow as the lite transaction keeps it. */
export interface LiteFlowState {
	interactionId: string;
	contractHash: string;
	signature: string;
}

/** What a start or resume answers that the driver uses. */
export interface LiteFlowView {
	state: LiteFlowState;
	/** The step the interaction is on, or null when the contract has none for it. */
	step: FlowRuntimeStep | null;
	/** The interaction's state (`active`, `completed`, …). */
	interactionState: string;
	/**
	 * Whether the contract asks for a code on a step other than this one (the SPA's
	 * `runtimeFlowHasCodeInputStep`): an authenticator code is then entered there, after its choice.
	 */
	codeInputElsewhere: boolean;
}

export type LiteFlowFailure = { ok: false; error: string; status: number };

/** Where a sign-in started: what the page's query says it continues. */
export interface LiteLoginTarget {
	clientId: string | null;
	authorizationChallengeId: string | null;
	samlRequestId: string | null;
	samlSpEntityId: string | null;
	returnTo: string | null;
}

const FLOW_START_PATH = '/api/v1/login/interactions/start';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The start or resume answer, as the driver keeps and draws it; null when it is malformed. */
export function readFlowStartAnswer(json: unknown): LiteFlowView | null {
	if (!isRecord(json) || !isRecord(json.interaction) || !isRecord(json.contract)) return null;
	const interactionId = readString(json.interaction.id);
	const contractHash = readString(json.contract_hash);
	const signature = readString(json.signature);
	if (!interactionId || !contractHash || !signature) return null;
	const ui = isRecord(json.contract.ui) ? json.contract.ui : null;
	const steps = Array.isArray(ui?.steps) ? (ui.steps as unknown[]) : [];
	const currentStepId = readString(json.interaction.current_step_id);
	const step =
		(steps.find((candidate) => isRecord(candidate) && candidate.id === currentStepId) as
			| FlowRuntimeStep
			| undefined) ?? null;
	const asksForCode = (candidate: unknown) =>
		isRecord(candidate) &&
		[candidate.config, candidate.content].some(
			(part) =>
				isRecord(part) &&
				isRecord(part.screen) &&
				Array.isArray(part.screen.fields) &&
				part.screen.fields.some(
					(field) => isRecord(field) && field.block_type === 'code_input_widget'
				)
		);
	return {
		state: { interactionId, contractHash, signature },
		step,
		interactionState: readString(json.interaction.state) ?? 'active',
		codeInputElsewhere: steps.some(
			(candidate) => isRecord(candidate) && candidate.id !== currentStepId && asksForCode(candidate)
		)
	};
}

function failure(answer: { status: number; json: unknown }): LiteFlowFailure {
	const error = isRecord(answer.json) ? readString(answer.json.error) : null;
	return { ok: false, error: error ?? 'flow_unavailable', status: answer.status };
}

/** The target of a new Flow, as the SPA builds it (`getRuntimeTarget`). */
function runtimeTarget(target: LiteLoginTarget): Record<string, unknown> {
	if (target.clientId) {
		return { target_type: 'oidc_client', target_id: target.clientId, client_id: target.clientId };
	}
	if (target.samlSpEntityId) {
		return {
			target_type: 'saml_sp',
			target_id: target.samlSpEntityId,
			saml_sp_id: target.samlSpEntityId
		};
	}
	return { target_type: 'tenant', target_id: null };
}

/** Starts a sign-in Flow (a page view may: it consumes nothing single-use, plan §14). */
export async function startLiteLoginFlow(
	backend: LiteBackendClient,
	target: LiteLoginTarget,
	locale: string
): Promise<{ ok: true; view: LiteFlowView } | LiteFlowFailure> {
	const answer = await backend.request(FLOW_START_PATH, {
		json: {
			flow_kind: 'login',
			locale,
			authorization_challenge_id: target.authorizationChallengeId ?? undefined,
			saml_request_id: target.samlRequestId ?? undefined,
			saml_sp_entity_id: target.samlSpEntityId ?? undefined,
			return_to: target.returnTo ?? undefined,
			...runtimeTarget(target)
		}
	});
	if (answer.status !== 200) return failure(answer);
	const view = readFlowStartAnswer(answer.json);
	return view ? { ok: true, view } : { ok: false, error: 'flow_malformed', status: 502 };
}

/** Resumes a kept Flow; the answer's hash and signature replace the kept ones. */
export async function resumeLiteFlow(
	backend: LiteBackendClient,
	state: LiteFlowState,
	locale: string
): Promise<{ ok: true; view: LiteFlowView } | LiteFlowFailure> {
	const answer = await backend.request(FLOW_START_PATH, {
		json: {
			resume_interaction_id: state.interactionId,
			contract_hash: state.contractHash,
			signature: state.signature,
			locale
		}
	});
	if (answer.status !== 200) return failure(answer);
	const view = readFlowStartAnswer(answer.json);
	return view ? { ok: true, view } : { ok: false, error: 'flow_malformed', status: 502 };
}

/** A kept Flow, read back from the transaction's data; null when there is none or it is bad. */
export function readKeptFlow(data: Record<string, unknown>): LiteFlowState | null {
	const flow = data.flow;
	if (!isRecord(flow)) return null;
	const interactionId = readString(flow.interactionId);
	const contractHash = readString(flow.contractHash);
	const signature = readString(flow.signature);
	return interactionId && contractHash && signature
		? { interactionId, contractHash, signature }
		: null;
}

/** A field of a screen step, as the lite page draws it. */
export interface LiteScreenField {
	blockType: string;
	field: string;
	label: string;
	required: boolean;
	authMethod: string | null;
	text: string | null;
	helpText: string | null;
	placeholder: string | null;
	/** An identity field's value type: `boolean` is drawn as a checkbox (as the SPA does). */
	valueType: string | null;
	/** A link block's destination, checked (safeLinkHref); null for any other block. */
	href: string | null;
	/** Whether the label is shown; `show_label: false` keeps it for screen readers only. */
	showLabel: boolean;
}

/**
 * A link's destination as the backend stores it (ar-management `readSafeLinkHref`), checked
 * again before it is drawn: an in-page anchor, a local path, or an https URL; nothing else.
 */
export function safeLinkHref(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const href = value.trim();
	if (!href || href.length > 2048) return null;
	// eslint-disable-next-line no-control-regex -- a control character is what it refuses
	if (/[\\\u0000-\u001f\u007f]/u.test(href)) return null;
	if (href.startsWith('#')) return /^#[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(href) ? href : null;
	if (href.startsWith('/')) return href.startsWith('//') ? null : href;
	try {
		const url = new URL(href);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
	} catch {
		return null;
	}
}

/** What a page does with the step its Flow is on. */
export type LiteStepDecision =
	/** Draw the screen's fields. */
	| { kind: 'screen'; title: string | null; description: string | null; fields: LiteScreenField[] }
	/** A step the SPA would submit on its own: a one-click Continue form (a verified post). */
	| { kind: 'continue' }
	/** Something the lite UI cannot draw or drive: stop before any side effect (plan R3-2). */
	| { kind: 'unsupported'; reasons: string[] };

function screenOf(step: FlowRuntimeStep): Record<string, unknown> | null {
	const fromConfig = isRecord(step.config) ? step.config.screen : undefined;
	const fromContent = isRecord(step.content) ? step.content.screen : undefined;
	if (isRecord(fromConfig)) return fromConfig;
	if (isRecord(fromContent)) return fromContent;
	return null;
}

function isHidden(field: Record<string, unknown>): boolean {
	const condition = field.display_condition;
	return isRecord(condition) && condition.mode === 'hidden';
}

/**
 * What the page does with a step: draw it, offer a Continue form, or stop. A block, a method or a
 * component outside the lite lists stops the page, with the reasons (never skipped silently).
 */
export function decideLiteStep(
	step: FlowRuntimeStep | null,
	/** A page's narrower lists (a page that does not do everything the lite UI will). */
	only: {
		blocks?: ReadonlySet<string>;
		methods?: ReadonlySet<string>;
		/** Which methods the step really offers (liteMethodAvailability); all, when left out. */
		isAvailable?: (method: RuntimeScreenAuthMethod) => boolean;
		/** Whether guest sign-in is on for the tenant. */
		guestEnabled?: boolean;
	} = {}
): LiteStepDecision {
	if (!step) return { kind: 'unsupported', reasons: ['step_missing'] };
	if (!LITE_FLOW_COMPONENTS.has(step.component)) {
		return { kind: 'unsupported', reasons: [`component:${step.component}`] };
	}
	if (runtimeAutoSubmitHandle(step) !== null) return { kind: 'continue' };

	const screen = screenOf(step);
	if (!screen || !Array.isArray(screen.fields)) {
		return { kind: 'unsupported', reasons: [`screen_missing:${step.component}`] };
	}
	const reasons: string[] = [];
	const fields: LiteScreenField[] = [];
	const isAvailable = only.isAvailable ?? (() => true);
	// A layout row hides or shows every block after it, up to the next row (SPA
	// `buildLayoutSections`); the row itself is not drawn.
	let rowVisible = true;
	for (const raw of screen.fields as unknown[]) {
		if (!isRecord(raw)) continue;
		const blockType = readString(raw.block_type) ?? 'identity_field';
		if (blockType === 'layout_row') {
			rowVisible = !isHidden(raw) && isDisplayConditionMet(raw as never, isAvailable);
			continue;
		}
		if (!rowVisible || isHidden(raw)) continue;
		// What the SPA would not draw is left out (not refused): a block whose display condition
		// is not met, a sign-in method that is off, guest sign-in when it is off.
		if (!isDisplayConditionMet(raw as never, isAvailable)) continue;
		if (blockType === 'auth_widget' && !isAvailable(authWidgetMethod(raw as never))) continue;
		if (blockType === 'guest_login_widget' && only.guestEnabled === false) continue;
		if (!LITE_SCREEN_BLOCK_TYPES.has(blockType) || (only.blocks && !only.blocks.has(blockType))) {
			reasons.push(`block:${blockType}`);
			continue;
		}
		const authMethod = readString(raw.auth_method);
		if (
			blockType === 'auth_widget' &&
			(!authMethod ||
				!LITE_AUTH_METHODS.has(authMethod) ||
				(only.methods !== undefined && !only.methods.has(authMethod)))
		) {
			reasons.push(`method:${authMethod ?? 'none'}`);
			continue;
		}
		fields.push({
			blockType,
			field: readString(raw.field) ?? '',
			label: readString(raw.label) ?? '',
			required: raw.required === true,
			authMethod,
			text: readString(raw.text),
			helpText: readString(raw.help_text),
			placeholder: readString(raw.placeholder),
			valueType: blockType === 'identity_field' ? readString(raw.value_type) : null,
			href: blockType === 'link' ? safeLinkHref(raw.href) : null,
			showLabel: raw.show_label !== false
		});
	}
	if (reasons.length > 0) return { kind: 'unsupported', reasons };
	// The SPA's shared email input (RuntimeScreen `sharedEmailWidgetKey`): a screen whose email
	// code (or authenticator) button has no email field of its own gets one, just before it.
	const isEmailField = (field: LiteScreenField) =>
		field.blockType === 'identity_field' &&
		(field.field.trim().toLowerCase() === 'email' ||
			field.field.trim().toLowerCase().endsWith('.email'));
	const owner = fields.findIndex(
		(field) =>
			field.blockType === 'auth_widget' &&
			(field.authMethod === 'mail_otp' ||
				field.authMethod === 'mail_otp_totp' ||
				field.authMethod === 'totp')
	);
	if (owner >= 0 && !fields.some(isEmailField)) {
		fields.splice(owner, 0, {
			blockType: 'identity_field',
			field: 'email',
			label: '',
			required: true,
			authMethod: null,
			text: null,
			helpText: null,
			placeholder: null,
			valueType: null,
			href: null,
			showLabel: true
		});
	}
	return {
		kind: 'screen',
		title: readString(screen.display_name),
		description: readString(screen.description),
		fields
	};
}
