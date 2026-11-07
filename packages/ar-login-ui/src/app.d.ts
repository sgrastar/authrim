// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare module 'svelte/elements' {
	interface HTMLInputAttributes {
		// Email Verification Protocol origin trial attribute. Svelte's HTML types do not include it yet.
		nonce?: string | undefined | null;
	}
}

declare global {
	interface Window {
		turnstile?: {
			render: (
				container: HTMLElement,
				options: {
					sitekey: string;
					action: string;
					theme: 'auto' | 'light' | 'dark';
					language?: string;
					size: 'flexible';
					execution?: 'render' | 'execute';
					appearance?: 'always' | 'execute' | 'interaction-only';
					callback: (value: string) => void;
					'expired-callback': () => void;
					'error-callback': () => void;
				}
			) => string;
			reset: (id: string) => void;
			remove: (id: string) => void;
			ready: (callback: () => void) => void;
		};
		hcaptcha?: {
			render: (
				container: HTMLElement,
				options: {
					sitekey: string;
					theme?: 'light' | 'dark';
					size?: 'normal' | 'compact' | 'invisible';
					callback: (value: string) => void;
					'expired-callback': () => void;
					'error-callback': () => void;
				}
			) => string;
			execute: (id: string) => void;
			reset: (id: string) => void;
			remove: (id: string) => void;
		};
		grecaptcha?: {
			ready: (callback: () => void) => void;
			render: (
				container: HTMLElement,
				options: {
					sitekey: string;
					theme?: 'light' | 'dark';
					size?: 'normal' | 'compact' | 'invisible';
					callback: (value: string) => void;
					'expired-callback': () => void;
					'error-callback': () => void;
				}
			) => string;
			execute: (siteKeyOrWidgetId: string, options?: { action?: string }) => Promise<string> | void;
			reset: (id?: string) => void;
		};
	}

	namespace App {
		// interface Error {}
		interface Locals {
			locale?: string;
			emailVerificationProtocolEnabled?: boolean;
			accountPageInitial?: import('#lib/server/account-page-initial-data.js').AccountPageInitialData;
			authenticationMethods?:
				| import('#lib/api/authentication-methods.js').AuthenticationMethodsResponse
				| null;
			/** The tenant's lite Login UI mode, as the request's authentication methods tell it. */
			loginUiLite?: import('#lib/lite/routing.js').LiteModeAnswer;
			/** What the Router checked at its edge, or the UI's own check (lib/server/edge-context.ts). */
			edge?: import('#lib/server/edge-context.js').EdgeContext;
			/**
			 * A lite action's finished sign-in: where its relay page goes. SvelteKit runs the page's
			 * load after an action; with this set, the load starts nothing and draws the relay.
			 */
			liteRelay?: { url: string; continueLabel: string };
			/** What a lite page adds to the lite CSP: a fixed script's hash, a relay's destination. */
			liteCsp?: { scriptHashes?: string[]; formAction?: string };
			loginChallengeThemeTarget?: {
				challengeId: string;
				valid: boolean;
				clientId: string | null;
			};
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
