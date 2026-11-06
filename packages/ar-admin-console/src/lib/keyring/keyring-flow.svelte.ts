/**
 * The "Add to Keyring" flow as a small state machine, kept apart from the page so its timing
 * can be tested.
 *
 *   idle → creating → qr → code → issued
 *                      └────┴──→ ended (failed | expired | locked)
 *   creating → error (the request itself was refused)
 *
 * The QR (credential offer) and the transaction code are never shown together: the code is held
 * here from the start but only shown once the wallet has fetched the offer. Offer and code live
 * in memory only and are dropped as soon as they are no longer needed.
 */
import {
	FRESH_AUTH_REQUIRED,
	WalletCredentialError,
	type WalletCredentialsClient,
	type WalletOffer,
	type WalletOfferState
} from '#lib/api/wallet-credentials.js';
import { keyConfirmationCode } from './confirmation-code.js';

export type KeyringPhase = 'idle' | 'creating' | 'qr' | 'code' | 'issued' | 'ended' | 'error';
export type KeyringEndReason = 'failed' | 'expired' | 'locked';

export const POLL_INTERVAL_MS = 2000;
export const COUNTDOWN_INTERVAL_MS = 1000;
/** Status checks that may fail in a row before the flow gives up. */
export const MAX_POLL_FAILURES = 5;
/** How long past the deadline an issuance already under way is followed (server lease is 60 s). */
export const ISSUANCE_GRACE_MS = 90_000;

export interface KeyringFlowOptions {
	client: WalletCredentialsClient;
	now?: () => number;
}

export class KeyringFlow {
	phase = $state<KeyringPhase>('idle');
	/** Set while the QR is on screen; cleared afterwards. */
	credentialOffer = $state('');
	/** Set while the code is on screen; cleared afterwards. */
	transactionCode = $state('');
	/** Milliseconds left until the offer expires (0 when there is none). */
	remainingMs = $state(0);
	endReason = $state<KeyringEndReason>('failed');
	/** Last request failure, for the page to explain. */
	error = $state<unknown>(null);
	confirmationCode = $state<string | null>(null);

	#client: WalletCredentialsClient;
	#now: () => number;
	#offerId = '';
	#heldCode = '';
	#expiresAt = 0;
	#visible = true;
	#pollTimer: ReturnType<typeof setTimeout> | undefined;
	#tickTimer: ReturnType<typeof setInterval> | undefined;
	#failures = 0;
	#polling = false;
	#finalizing = false;
	/** Past the local deadline: only #finalCheck asks the server, and it reschedules itself. */
	#finalPhase = false;
	#generation = 0;

	constructor(options: KeyringFlowOptions) {
		this.#client = options.client;
		this.#now = options.now ?? Date.now;
	}

	get active(): boolean {
		return this.phase === 'qr' || this.phase === 'code';
	}

	get needsFreshAuth(): boolean {
		return this.error instanceof WalletCredentialError && this.error.code === FRESH_AUTH_REQUIRED;
	}

	/** Create an offer (or a new one, starting over). */
	async start(): Promise<void> {
		this.#reset();
		const generation = ++this.#generation;
		this.phase = 'creating';
		let offer: WalletOffer;
		try {
			offer = await this.#client.createOffer();
		} catch (error) {
			if (generation !== this.#generation) return;
			this.error = error;
			this.phase = 'error';
			return;
		}
		if (generation !== this.#generation) return;
		this.#offerId = offer.offerId;
		this.#heldCode = offer.transactionCode;
		this.#expiresAt = offer.expiresAt;
		this.credentialOffer = offer.credentialOffer;
		this.remainingMs = Math.max(0, offer.expiresAt - this.#now());
		this.phase = 'qr';
		if (this.remainingMs === 0) return this.#end('expired');
		this.#tickTimer = setInterval(() => this.#tick(), COUNTDOWN_INTERVAL_MS);
		this.#schedulePoll(0);
	}

	/** Called with the page's visibility: no polling while hidden. */
	setVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		if (!this.active) return;
		if (visible) {
			this.#tick();
			if (!this.active) return;
			if (this.#finalPhase) void this.#finalCheck();
			else this.#schedulePoll(0);
		} else {
			this.#clearPoll();
		}
	}

	/** Stop all timers and drop the secrets (page left). */
	destroy(): void {
		this.#generation++;
		this.#reset();
		this.phase = 'idle';
	}

	#reset(): void {
		this.#clearPoll();
		if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
		this.#tickTimer = undefined;
		this.credentialOffer = '';
		this.transactionCode = '';
		this.#heldCode = '';
		this.#offerId = '';
		this.remainingMs = 0;
		this.confirmationCode = null;
		this.error = null;
		this.#failures = 0;
		this.#polling = false;
		this.#finalizing = false;
		this.#finalPhase = false;
	}

	#clearPoll(): void {
		if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	#schedulePoll(delay: number): void {
		// In the final phase the timer belongs to #finalCheck; a late ordinary poll must not touch it.
		if (this.#finalPhase) return;
		this.#clearPoll();
		if (!this.active || !this.#visible) return;
		this.#pollTimer = setTimeout(() => void this.#poll(), delay);
	}

	#tick(): void {
		if (!this.active) return;
		this.remainingMs = Math.max(0, this.#expiresAt - this.#now());
		if (this.remainingMs === 0 && !this.#finalPhase) {
			this.#finalPhase = true;
			this.#clearPoll();
			// While hidden the result is checked on return, never decided in the background.
			if (this.#visible) void this.#finalCheck();
		}
	}

	/**
	 * The local deadline passed: the server decides. An issuance already under way is followed
	 * until the server reports an end state (bounded by ISSUANCE_GRACE_MS); a failed request is
	 * retried and never taken as expiry.
	 */
	async #finalCheck(): Promise<void> {
		if (this.#finalizing || !this.active || !this.#visible) return;
		this.#finalizing = true;
		this.#clearPoll();
		const generation = this.#generation;
		let retry = false;
		try {
			const status = await this.#client.getOfferStatus(this.#offerId);
			if (generation !== this.#generation || !this.active) return;
			this.#failures = 0;
			this.#apply(status.state, status.holderKeyThumbprint);
			if (!this.active) return;
			const serverDeadline = Number.isFinite(status.expiresAt) ? status.expiresAt : 0;
			// The grace runs from the latest deadline the server has given, not the first one.
			const latestDeadline = Math.max(this.#expiresAt, serverDeadline);
			const inFlight =
				status.state === 'token_issued' && this.#now() < latestDeadline + ISSUANCE_GRACE_MS;
			if (serverDeadline > this.#now()) {
				// The server still allows issuance: back to the ordinary countdown and polling.
				this.#expiresAt = serverDeadline;
				this.remainingMs = serverDeadline - this.#now();
				this.#finalPhase = false;
				this.#schedulePoll(POLL_INTERVAL_MS);
				return;
			}
			if (inFlight) {
				this.#expiresAt = latestDeadline;
				retry = true;
				return;
			}
			this.#end('expired');
		} catch (error) {
			if (generation !== this.#generation || !this.active) return;
			if (error instanceof WalletCredentialError && error.code === 'not_found') {
				this.#end('expired');
				return;
			}
			if (++this.#failures >= MAX_POLL_FAILURES) {
				this.#end('failed');
				return;
			}
			retry = true;
		} finally {
			if (generation === this.#generation) {
				this.#finalizing = false;
				if (retry && this.active && this.#visible) {
					this.#pollTimer = setTimeout(() => void this.#finalCheck(), POLL_INTERVAL_MS);
				}
			}
		}
	}

	#end(reason: KeyringEndReason): void {
		this.#clearPoll();
		if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
		this.#tickTimer = undefined;
		this.credentialOffer = '';
		this.transactionCode = '';
		this.#heldCode = '';
		this.remainingMs = 0;
		this.endReason = reason;
		this.phase = 'ended';
	}

	async #poll(): Promise<void> {
		if (this.#polling || !this.active || !this.#visible) return;
		this.#polling = true;
		const generation = this.#generation;
		const offerId = this.#offerId;
		try {
			const status = await this.#client.getOfferStatus(offerId);
			if (generation !== this.#generation || !this.active) return;
			this.#failures = 0;
			// The server's deadline is authoritative: after the token exchange it follows the token.
			if (Number.isFinite(status.expiresAt) && status.expiresAt > 0) {
				this.#expiresAt = status.expiresAt;
			}
			this.#apply(status.state, status.holderKeyThumbprint);
		} catch (error) {
			if (generation !== this.#generation || !this.active) return;
			if (error instanceof WalletCredentialError && error.code === 'not_found') {
				this.#end('expired');
				return;
			}
			if (++this.#failures >= MAX_POLL_FAILURES) {
				this.#end('failed');
				return;
			}
		} finally {
			if (generation === this.#generation) this.#polling = false;
		}
		if (generation === this.#generation) this.#schedulePoll(POLL_INTERVAL_MS);
	}

	#apply(state: WalletOfferState, thumbprint: string | undefined): void {
		switch (state) {
			case 'fetched':
			case 'token_issued':
				if (this.phase === 'qr') {
					// The wallet has the offer: the QR goes away and the code appears.
					this.credentialOffer = '';
					this.transactionCode = this.#heldCode;
					this.phase = 'code';
				}
				return;
			case 'issued': {
				const code = thumbprint ? keyConfirmationCode(thumbprint) : null;
				this.#clearPoll();
				if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
				this.#tickTimer = undefined;
				this.credentialOffer = '';
				this.transactionCode = '';
				this.#heldCode = '';
				this.remainingMs = 0;
				this.confirmationCode = code;
				this.phase = 'issued';
				return;
			}
			case 'failed':
			case 'expired':
			case 'locked':
				this.#end(state);
				return;
			case 'pending':
				return;
		}
	}
}
