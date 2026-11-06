/**
 * The question a step-up asks when the admin has a Keyring second factor: confirm with a
 * security key, or present the admin credential from Keyring. One prompt for the whole console,
 * shown by <SecondFactorPrompt> (mounted once in the root layout) and answered through a promise,
 * so the API layer can ask it from inside withStepUp.
 */
import type { KeyringFactorClient } from '#lib/api/keyring-factor.js';
import {
	browserSupportsDigitalCredentials,
	KeyringPresentationFlow
} from './presentation-flow.svelte.js';

export type SecondFactorAnswer = 'security_key' | 'keyring_verified';

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
	/** Set once Keyring was chosen. */
	flow = $state<KeyringPresentationFlow | null>(null);

	#client: KeyringFactorClient | null = null;
	#dcApi = false;
	#resolve: ((answer: SecondFactorAnswer) => void) | null = null;
	#reject: ((error: Error) => void) | null = null;

	/**
	 * Ask how to confirm. Resolves with `security_key` (the caller runs the key's ceremony) or
	 * `keyring_verified` (the server has recorded the Keyring factor). Rejects when closed.
	 */
	ask(options: {
		hasSecurityKey: boolean;
		client: KeyringFactorClient;
		/** The platform lets Keyring answer through the browser (Digital Credentials API). */
		dcApi?: boolean;
	}): Promise<SecondFactorAnswer> {
		// A prompt already open is closed as cancelled: one question at a time.
		this.cancel();
		this.#client = options.client;
		this.#dcApi = options.dcApi === true;
		this.hasSecurityKey = options.hasSecurityKey;
		this.open = true;
		const answer = new Promise<SecondFactorAnswer>((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		// Keyring is the only factor: go straight to it.
		if (!options.hasSecurityKey) this.chooseKeyring();
		return answer;
	}

	chooseSecurityKey(): void {
		this.#settle('security_key');
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
		this.open = false;
		this.#resolve = null;
		this.#reject = null;
		this.#client = null;
	}
}

export const secondFactorPrompt = new SecondFactorPromptState();
