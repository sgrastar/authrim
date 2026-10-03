/**
 * What the login and signup routes hand their views. The routes own the state and the requests;
 * these shapes carry only what the page draws.
 */
import type {
	FlowRuntimeConsentPolicyContent,
	FlowRuntimeDestinationFieldConsentContent
} from '$lib/api/flow-runtime';
import type { RuntimeAuthMethod } from '$lib/authrim/runtime-auth-handles';

export type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'recaptcha' | 'custom';
export type HumanVerificationMode = 'managed' | 'checkbox' | 'invisible' | 'score';

/** The tenant's human-verification widget, shared by every method on the page. */
export type HumanVerificationView = {
	siteKey: string | null;
	provider: HumanVerificationProvider;
	mode: HumanVerificationMode;
	action: string;
	theme: 'light' | 'dark';
	language: string;
	/** Bumped by the route to clear a used token. */
	resetKey: number;
	/** Whether the runtime screen has to draw its own widget. */
	runtimeRequired: boolean;
	/** Whether a method is waiting on a token, so the runtime screen shows its widget. */
	runtimeVisible: boolean;
};

/** One external identity provider button, with its icon URL and colour already checked. */
export type ExternalProviderButton = {
	id: string;
	/** The provider's name, as the runtime screen labels it. */
	label: string;
	/** The full button text the classic layout shows ("Continue with …" unless the tenant set one). */
	text: string;
	/** Only set when it passed `isValidImageUrl`. */
	iconUrl: string | null;
	iconClass: string;
	/** Border and text colour from a sanitised provider colour, or ''. */
	style: string;
};

/** The flow-runtime step the page is on, read once from the step so the view need not parse it. */
export type RuntimeStepView = {
	component: string;
	/** An authentication step: its runtime screen submits through the methods, not a Continue. */
	isAuthStep: boolean;
	/** The Admin console screen to draw, or null to fall back to the plain step panel. */
	screen: Record<string, unknown> | null;
	title: string;
	description: string;
	consentPolicy: FlowRuntimeConsentPolicyContent | null;
	destinationFieldConsent: FlowRuntimeDestinationFieldConsentContent | null;
};

/** What the runtime screen draws beside the step itself; it changes as the person types. */
export type RuntimeScreenState = {
	fieldValues: Record<string, string>;
	methodAvailability: Partial<Record<RuntimeAuthMethod, boolean>>;
	methodLoading: Partial<Record<RuntimeAuthMethod, boolean>>;
	destinationFieldDecisions: Record<string, boolean>;
	consentSelectedValues: Record<string, string>;
	/** Every required consent item and destination field has been answered. */
	consentReady: boolean;
	/** The runtime step is being submitted. */
	loading: boolean;
};

/** The email-verification protocol challenge for the current step, when the tenant uses it. */
export type EmailVerificationView = {
	enabled: boolean;
	nonce: string | null;
};
