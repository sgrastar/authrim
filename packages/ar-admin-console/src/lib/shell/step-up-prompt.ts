import type { StepUpPromptRequest } from '#lib/api/admin-step-up.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * What the step-up dialog says: "This operation is L1. It takes one passkey verification and one
 * second-factor verification (security key or Keyring). Continue?", each check named once, in the order they are made.
 */
export function stepUpPromptBody(request: StepUpPromptRequest, translate: Translate): string {
	const factors = (['passkey', 'second_factor'] as const)
		.filter((factor) => request.factors.includes(factor))
		.map((factor) => translate(`stepUp.factor.${factor}`))
		.join(translate('stepUp.factorJoin'));
	return translate('stepUp.body', { level: request.level, factors });
}

export interface StepUpAsker {
	/** The prompt to register: shows the request and resolves with the admin's answer. */
	ask: (request: StepUpPromptRequest) => Promise<boolean>;
	/** The admin answered (true to go on). */
	settle: (go: boolean) => void;
	/** The dialog is gone: what is open is declined, and so is whatever asks later. */
	close: () => void;
}

/**
 * The dialog's queue of one: a newer request declines one still open, and once the dialog is
 * gone every request is declined, so that no step-up waits on a dialog nobody can see.
 */
export function stepUpAsker(show: (request: StepUpPromptRequest | null) => void): StepUpAsker {
	let answer: ((go: boolean) => void) | null = null;
	let gone = false;
	const settle = (go: boolean) => {
		const resolve = answer;
		answer = null;
		show(null);
		resolve?.(go);
	};
	return {
		ask(request) {
			if (gone) return Promise.resolve(false);
			return new Promise<boolean>((resolve) => {
				answer?.(false);
				answer = resolve;
				show(request);
			});
		},
		settle,
		close() {
			gone = true;
			settle(false);
		}
	};
}
