/**
 * A Keyring presentation (the admin credential presented as a second factor) as a small state
 * machine, kept apart from the dialog so its timing can be tested.
 *
 *   idle → starting → waiting → verified
 *                       └──→ ended (failed | expired)
 *   starting → error (the request itself was refused)
 *
 * While waiting, the QR code and the two-digit match code are on screen; the admin scans the
 * code with Keyring, types the number there and confirms with Face ID. The server is asked for
 * the progress every two seconds while the page is visible. Both values live in memory only and
 * are dropped once the presentation is over.
 */

export type PresentationPhase = 'idle' | 'starting' | 'waiting' | 'verified' | 'ended' | 'error';
export type PresentationEndReason = 'failed' | 'expired';

export interface PresentationStart {
	requestId: string;
	qr: string;
	matchCode: string;
	expiresAt: number;
}

export interface PresentationProgress {
	status: 'pending' | 'processing' | 'verified' | 'failed' | 'expired' | 'consumed';
	/** Why it failed (server code, e.g. match_code_mismatch). */
	error?: string;
}

export interface PresentationFlowOptions {
	start: () => Promise<PresentationStart>;
	progress: (requestId: string) => Promise<PresentationProgress>;
	/** Called once, when the server reports the presentation verified and recorded. */
	onverified?: () => void;
	now?: () => number;
}

export const POLL_INTERVAL_MS = 2000;
export const COUNTDOWN_INTERVAL_MS = 1000;
/** Status checks that may fail in a row before the flow gives up. */
export const MAX_POLL_FAILURES = 5;
/** How long past the deadline a verification already under way is followed (server lease 30 s). */
export const VERIFICATION_GRACE_MS = 35_000;

export class KeyringPresentationFlow {
	phase = $state<PresentationPhase>('idle');
	/** openid4vp:// value for the QR code, while waiting. */
	qr = $state('');
	/** The two digits to type into Keyring, while waiting. */
	matchCode = $state('');
	/** The wallet has answered and the server is checking the answer. */
	checking = $state(false);
	remainingMs = $state(0);
	endReason = $state<PresentationEndReason>('failed');
	/** The server's reason for a failed presentation, if it gave one. */
	failure = $state<string | null>(null);
	/** The error that refused the start. */
	error = $state<unknown>(null);

	#options: PresentationFlowOptions;
	#now: () => number;
	#requestId = '';
	#expiresAt = 0;
	#visible = true;
	#pollTimer: ReturnType<typeof setTimeout> | undefined;
	#tickTimer: ReturnType<typeof setInterval> | undefined;
	#failures = 0;
	#polling = false;
	#generation = 0;

	constructor(options: PresentationFlowOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	get waiting(): boolean {
		return this.phase === 'waiting';
	}

	/** Start a presentation (or a new one, starting over). */
	async start(): Promise<void> {
		this.#reset();
		const generation = ++this.#generation;
		this.phase = 'starting';
		let started: PresentationStart;
		try {
			started = await this.#options.start();
		} catch (error) {
			if (generation !== this.#generation) return;
			this.error = error;
			this.phase = 'error';
			return;
		}
		if (generation !== this.#generation) return;
		this.#requestId = started.requestId;
		this.#expiresAt = started.expiresAt;
		this.qr = started.qr;
		this.matchCode = started.matchCode;
		this.remainingMs = Math.max(0, started.expiresAt - this.#now());
		this.phase = 'waiting';
		this.#tickTimer = setInterval(() => this.#tick(), COUNTDOWN_INTERVAL_MS);
		this.#schedulePoll(POLL_INTERVAL_MS);
	}

	/** Called with the page's visibility: no polling while hidden. */
	setVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		if (!this.waiting) return;
		if (visible) {
			this.#tick();
			this.#schedulePoll(0);
		} else {
			this.#clearPoll();
		}
	}

	/** Stop every timer and drop the values (dialog closed). */
	destroy(): void {
		this.#generation++;
		this.#reset();
		this.phase = 'idle';
	}

	#reset(): void {
		this.#clearPoll();
		if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
		this.#tickTimer = undefined;
		this.qr = '';
		this.matchCode = '';
		this.checking = false;
		this.remainingMs = 0;
		this.failure = null;
		this.error = null;
		this.#requestId = '';
		this.#failures = 0;
		this.#polling = false;
	}

	#clearPoll(): void {
		if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	#schedulePoll(delay: number): void {
		this.#clearPoll();
		if (!this.waiting || !this.#visible) return;
		this.#pollTimer = setTimeout(() => void this.#poll(), delay);
	}

	#tick(): void {
		if (!this.waiting) return;
		this.remainingMs = Math.max(0, this.#expiresAt - this.#now());
		// Past the deadline only an answer the server is still checking is followed, and not for
		// long; the server decides, and is asked once more before the flow gives up.
		if (this.remainingMs === 0 && !this.checking) {
			if (this.#now() >= this.#expiresAt + POLL_INTERVAL_MS) this.#end('expired');
		} else if (this.#now() >= this.#expiresAt + VERIFICATION_GRACE_MS) {
			this.#end('expired');
		}
	}

	#end(reason: PresentationEndReason, failure: string | null = null): void {
		this.#clearPoll();
		if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
		this.#tickTimer = undefined;
		this.qr = '';
		this.matchCode = '';
		this.checking = false;
		this.remainingMs = 0;
		this.endReason = reason;
		this.failure = failure;
		this.phase = 'ended';
	}

	async #poll(): Promise<void> {
		if (this.#polling || !this.waiting || !this.#visible) return;
		this.#polling = true;
		const generation = this.#generation;
		try {
			const progress = await this.#options.progress(this.#requestId);
			if (generation !== this.#generation || !this.waiting) return;
			this.#failures = 0;
			this.#apply(progress);
		} catch {
			if (generation !== this.#generation || !this.waiting) return;
			if (++this.#failures >= MAX_POLL_FAILURES) this.#end('failed');
		} finally {
			if (generation === this.#generation) this.#polling = false;
		}
		if (generation === this.#generation) this.#schedulePoll(POLL_INTERVAL_MS);
	}

	#apply(progress: PresentationProgress): void {
		switch (progress.status) {
			case 'pending':
				return;
			case 'processing':
				this.checking = true;
				return;
			case 'verified':
				this.#reset();
				this.phase = 'verified';
				this.#options.onverified?.();
				return;
			case 'expired':
				this.#end('expired');
				return;
			// Consumed elsewhere (another tab of this session) is no result for this dialog.
			case 'consumed':
			case 'failed':
				this.#end('failed', progress.error ?? null);
				return;
		}
	}
}
