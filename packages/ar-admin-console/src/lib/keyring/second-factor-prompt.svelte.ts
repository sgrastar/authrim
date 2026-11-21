/**
 * The question a step-up asks when the admin has more than a security key to confirm with: a
 * security key, the admin credential from Keyring, or a code from an authenticator app. One
 * prompt for the whole console,
 * shown by <SecondFactorPrompt> (mounted once in the root layout) and answered through a promise,
 * so the API layer can ask it from inside withStepUp.
 */
import type { KeyringFactorClient } from '#lib/api/keyring-factor.js';
import {
	browserSupportsDigitalCredentials,
	KeyringPresentationFlow
} from './presentation-flow.svelte.js';

export type SecondFactorAnswer = 'security_key' | 'keyring_verified' | 'totp_verified';

/** Why a code was not accepted: what the admin can do about it. */
export type TotpFailure = 'invalid' | 'rate_limited' | 'not_allowed' | 'unavailable';

/** Thrown when the admin closes the prompt; named like a cancelled WebAuthn ceremony. */
export class SecondFactorCancelled extends Error {
	constructor() {
		super('The second-factor confirmation was cancelled');
		this.name = 'NotAllowedError';
	}
}

export class SecondFactorPromptState {
	open = $state(false);
	hasSecurityKey = $state(false);
	hasKeyring = $state(true);
	hasTotp = $state(false);
	/** Set once the authenticator app was chosen: the code is asked for. */
	totpStep = $state(false);
	totpBusy = $state(false);
	totpFailure = $state<TotpFailure | null>(null);
	/** Set once Keyring was chosen. */
	flow = $state<KeyringPresentationFlow | null>(null);

	#client: KeyringFactorClient | null = null;
	#dcApi = false;
	#verifyTotp: ((code: string) => Promise<void>) | null = null;
	/** Which question is open: an answer that arrives for an earlier one is ignored. */
	#generation = 0;
	#resolve: ((answer: SecondFactorAnswer) => void) | null = null;
	#reject: ((error: Error) => void) | null = null;

	/**
	 * Ask how to confirm. Resolves with `security_key` (the caller runs the key's ceremony),
	 * `keyring_verified` (the server has recorded the Keyring factor) or `totp_verified` (the code
	 * was accepted by `verifyTotp`, which the prompt calls itself so a wrong code can be retyped).
	 * Rejects when closed. Keyring is assumed unless `hasKeyring` is false.
	 */
	ask(options: {
		hasSecurityKey: boolean;
		hasKeyring?: boolean;
		hasTotp?: boolean;
		client: KeyringFactorClient;
		/** The platform lets Keyring answer through the browser (Digital Credentials API). */
		dcApi?: boolean;
		/** Verifies a code from the authenticator app on the server; throws when it is refused. */
		verifyTotp?: (code: string) => Promise<void>;
	}): Promise<SecondFactorAnswer> {
		// A prompt already open is closed as cancelled: one question at a time.
		this.cancel();
		this.#generation += 1;
		this.#client = options.client;
		this.#dcApi = options.dcApi === true;
		this.#verifyTotp = options.verifyTotp ?? null;
		this.hasSecurityKey = options.hasSecurityKey;
		this.hasKeyring = options.hasKeyring !== false;
		this.hasTotp = options.hasTotp === true && this.#verifyTotp !== null;
		this.totpStep = false;
		this.totpBusy = false;
		this.totpFailure = null;
		this.open = true;
		const answer = new Promise<SecondFactorAnswer>((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		// One way to confirm only: go straight to it.
		const ways = [this.hasKeyring, options.hasSecurityKey, this.hasTotp].filter(Boolean).length;
		if (ways === 1) {
			if (this.hasKeyring) this.chooseKeyring();
			else if (this.hasTotp) this.chooseTotp();
			else this.chooseSecurityKey();
		}
		return answer;
	}

	chooseSecurityKey(): void {
		this.#settle('security_key');
	}

	chooseTotp(): void {
		if (!this.hasTotp) return;
		this.totpFailure = null;
		this.totpStep = true;
	}

	/** Verify a code from the authenticator app; a refused code leaves the prompt open to retype. */
	async submitTotp(code: string): Promise<void> {
		const verify = this.#verifyTotp;
		if (!verify || this.totpBusy) return;
		const generation = this.#generation;
		this.totpBusy = true;
		this.totpFailure = null;
		try {
			await verify(code.replace(/\s+/g, ''));
		} catch (error) {
			// The question was closed (or another one opened) while the request was out: this
			// answer is for a prompt that is gone, and must not touch the one on screen.
			if (!this.open || generation !== this.#generation) return;
			this.totpFailure = totpFailureOf(error);
			this.totpBusy = false;
			return;
		}
		if (!this.open || generation !== this.#generation) return;
		this.totpBusy = false;
		this.#settle('totp_verified');
	}

	chooseKeyring(): void {
		const client = this.#client;
		if (!client) return;
		this.flow?.destroy();
		this.flow = new KeyringPresentationFlow({
			start: () => client.startStepUp(),
			progress: (id) => client.stepUpProgress(id),
			onverified: () => this.#settle('keyring_verified'),
			// Through the browser when the platform allows it and the browser can; the QR code stays.
			...(this.#dcApi && browserSupportsDigitalCredentials()
				? {
						browser: {
							start: () => client.startStepUpInBrowser(),
							submit: (id: string, data: unknown) => client.submitStepUp(id, data)
						}
					}
				: {})
		});
		void this.flow.start();
	}

	/** Start the Keyring presentation again (after a failure or the end of the time). */
	retry(): void {
		void this.flow?.start();
	}

	/** Leave the browser path for the QR code. */
	useQr(): void {
		void this.flow?.start({ qr: true });
	}

	/** Back to the choice of factor, when there is one. */
	back(): void {
		this.flow?.destroy();
		this.flow = null;
		this.totpStep = false;
		this.totpFailure = null;
	}

	/** Whether there is a choice to go back to. */
	get canGoBack(): boolean {
		return [this.hasKeyring, this.hasSecurityKey, this.hasTotp].filter(Boolean).length > 1;
	}

	cancel(): void {
		const reject = this.#reject;
		this.#close();
		reject?.(new SecondFactorCancelled());
	}

	#settle(answer: SecondFactorAnswer): void {
		const resolve = this.#resolve;
		this.#close();
		resolve?.(answer);
	}

	#close(): void {
		this.flow?.destroy();
		this.flow = null;
		this.totpStep = false;
		this.totpBusy = false;
		this.totpFailure = null;
		this.open = false;
		this.#resolve = null;
		this.#reject = null;
		this.#client = null;
		this.#verifyTotp = null;
	}
}

function totpFailureOf(error: unknown): TotpFailure {
	const status = (error as { status?: unknown } | null)?.status;
	const code = (error as { code?: unknown } | null)?.code;
	if (code === 'verification_failed') return 'invalid';
	if (status === 429 || code === 'rate_limited') return 'rate_limited';
	if (code === 'second_factor_kind_not_allowed') return 'not_allowed';
	return 'unavailable';
}

export const secondFactorPrompt = new SecondFactorPromptState();
