// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
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
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
