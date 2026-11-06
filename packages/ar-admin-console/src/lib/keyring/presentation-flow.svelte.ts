/**
 * A Keyring presentation (the admin credential presented as a second factor) as a small state
 * machine, kept apart from the dialog so its timing can be tested.
 *
 *   idle → starting → waiting → verified
 *                       └──→ ended (failed | expired)
 *   starting → error (the request itself was refused)
 *   starting → ready → browser → verified (Digital Credentials API; `ready` waits for a click,
 *                                          since the browser's dialog needs a fresh user action)
 *
 * While waiting, the QR code and the two-digit match code are on screen; the admin scans the
 * code with Keyring, types the number there and confirms with Face ID. The server is asked for
 * the progress every two seconds while the page is visible. Both values live in memory only and
 * are dropped once the presentation is over.
 */

export type PresentationPhase =
	| 'idle'
	| 'starting'
	| 'waiting'
	/** The browser request is prepared; the admin opens the browser's dialog with a click. */
	| 'ready'
	/** The browser's own dialog is open (Digital Credentials API). */
	| 'browser'
	| 'verified'
	| 'ended'
	| 'error';

/** A request for the browser's Digital Credentials API. */
export interface BrowserPresentationStart {
	requestId: string;
	dcRequest: { protocol: string; data: { request: string } };
	expiresAt: number;
}

/**
 * Present through the browser instead of a QR code: the browser shows its own dialog, finds
 * Keyring and binds the answer to this origin. `get` stands for navigator.credentials.get.
 */
export interface BrowserPresentationOptions {
	start: () => Promise<BrowserPresentationStart>;
	submit: (requestId: string, data: unknown) => Promise<PresentationProgress>;
	get?: (request: BrowserPresentationStart['dcRequest']) => Promise<unknown>;
}

/** Whether this browser can ask for a credential through the Digital Credentials API. */
export function browserSupportsDigitalCredentials(): boolean {
	return (
		typeof window !== 'undefined' &&
		'DigitalCredential' in window &&
		typeof navigator !== 'undefined' &&
		typeof navigator.credentials?.get === 'function'
	);
}

async function askBrowser(request: BrowserPresentationStart['dcRequest']): Promise<unknown> {
	const credential = (await navigator.credentials.get({
		mediation: 'required',
		digital: { requests: [request] }
	} as CredentialRequestOptions)) as { data?: unknown } | null;
	if (!credential || credential.data === undefined) throw new Error('No credential was returned');
	return credential.data;
}
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
	/** Present through the browser first (falling back to the QR code on request). */
	browser?: BrowserPresentationOptions;
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
	/** The server was asked after the local deadline (the flow never ends before that). */
	#askedAfterDeadline = false;
	#generation = 0;
	#prepared: { browser: BrowserPresentationOptions; started: BrowserPresentationStart } | null =
		null;

	constructor(options: PresentationFlowOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	get waiting(): boolean {
		return this.phase === 'waiting';
	}

	/** Whether the browser path is offered (and the QR code is the fallback). */
	get canUseBrowser(): boolean {
		return this.#options.browser !== undefined;
	}

	/**
	 * Start: through the browser when it is offered, otherwise (or with `qr`) with a QR code.
	 */
	async start(options: { qr?: boolean } = {}): Promise<void> {
		if (this.#options.browser && !options.qr) return this.#startInBrowser(this.#options.browser);
		return this.#startWithQr();
	}

	async #startInBrowser(browser: BrowserPresentationOptions): Promise<void> {
		this.#reset();
		const generation = ++this.#generation;
		this.phase = 'starting';
		let started: BrowserPresentationStart;
		try {
			started = await browser.start();
		} catch (error) {
			if (generation !== this.#generation) return;
			this.error = error;
			this.phase = 'error';
			return;
		}
		if (generation !== this.#generation) return;
		// The request (and any step-up before it) took time, and may have used the click that
		// started it: the browser's dialog is opened by the next one, in openBrowser().
		this.#prepared = { browser, started };
		this.#expiresAt = started.expiresAt;
		this.phase = 'ready';
		// A request left unopened past its lifetime is over: offer a fresh attempt instead.
		this.#tickTimer = setInterval(() => {
			if (this.phase === 'ready' && this.#now() >= this.#expiresAt) this.#end('expired');
		}, COUNTDOWN_INTERVAL_MS);
	}

	/**
	 * Open the browser's dialog for the prepared request. Call it straight from a click handler:
	 * the Digital Credentials API needs a transient user activation, so nothing is awaited before
	 * the browser is asked.
	 */
	async openBrowser(): Promise<void> {
		const prepared = this.#prepared;
		if (this.phase !== 'ready' || !prepared) return;
		if (this.#now() >= prepared.started.expiresAt) {
			this.#end('expired');
			return;
		}
		this.#prepared = null;
		if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
		this.#tickTimer = undefined;
		const { browser, started } = prepared;
		const generation = this.#generation;
		this.phase = 'browser';
		let progress: PresentationProgress;
		try {
			const data = await (browser.get ?? askBrowser)(started.dcRequest);
			if (generation !== this.#generation) return;
			progress = await browser.submit(started.requestId, data);
		} catch (error) {
			if (generation !== this.#generation) return;
			// Cancelled in the browser's dialog, or the browser could not do it: the QR code remains.
			this.error = error;
			this.phase = 'error';
			return;
		}
		if (generation !== this.#generation) return;
		if (progress.status === 'verified') {
			this.phase = 'verified';
			this.#options.onverified?.();
		} else {
			this.#end('failed', progress.error ?? null);
		}
	}

	async #startWithQr(): Promise<void> {
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
		this.#prepared = null;
		this.#requestId = '';
		this.#failures = 0;
		this.#polling = false;
		this.#askedAfterDeadline = false;
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
		// Past the deadline the server decides: the flow ends only once it has been asked after
		// the deadline (a result verified while the page was hidden is still collected). An answer
		// the server is still checking is followed a little longer.
		if (this.remainingMs > 0 || !this.#askedAfterDeadline) return;
		const grace = this.checking ? VERIFICATION_GRACE_MS : POLL_INTERVAL_MS;
		if (this.#now() >= this.#expiresAt + grace) this.#end('expired');
	}

	#end(reason: PresentationEndReason, failure: string | null = null): void {
		this.#clearPoll();
		this.#prepared = null;
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
		const askedAt = this.#now();
		try {
			const progress = await this.#options.progress(this.#requestId);
			if (generation !== this.#generation || !this.waiting) return;
			this.#failures = 0;
			if (askedAt >= this.#expiresAt) this.#askedAfterDeadline = true;
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
