/**
 * DiagnosticLogger for Login UI
 *
 * Compatible interface with @authrim/web's DiagnosticLogger.
 * Collects token validation and auth decision logs, persists to localStorage,
 * and sends batches to the server's diagnostic log ingest endpoint.
 *
 * The Login UI is registered as a public OAuth client (token_endpoint_auth_method=none),
 * so only client_id is required for ingest authentication (no client_secret).
 */

// =============================================================================
// Types
// =============================================================================

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TokenValidationStep =
	| 'issuer-check'
	| 'audience-check'
	| 'expiry-check'
	| 'nonce-check'
	| 'signature-check'
	| 'hash-check';

export interface BaseDiagnosticLogEntry {
	id: string;
	diagnosticSessionId: string;
	category: string;
	level: DiagnosticLogLevel;
	timestamp: number;
	metadata?: Record<string, unknown>;
}

export interface TokenValidationLogEntry extends BaseDiagnosticLogEntry {
	category: 'token-validation';
	step: TokenValidationStep;
	tokenType: string;
	result: 'pass' | 'fail';
	expected?: unknown;
	actual?: unknown;
	errorMessage?: string;
	details?: Record<string, unknown>;
}

export interface AuthDecisionLogEntry extends BaseDiagnosticLogEntry {
	category: 'auth-decision';
	decision: 'allow' | 'deny';
	reason: string;
	flow?: string;
	context?: Record<string, unknown>;
}

export type DiagnosticLogEntry = TokenValidationLogEntry | AuthDecisionLogEntry;

export interface DiagnosticLoggerOptions {
	enabled: boolean;
	persistToStorage?: boolean;
	storageKeyPrefix?: string;
	maxLogs?: number;
	sessionId?: string;
	sendToServer?: boolean;
	serverUrl?: string;
	clientId?: string;
	/** For confidential clients only. Login UI uses public client so this is not needed. */
	clientSecret?: string;
	batchSize?: number;
	flushIntervalMs?: number;
}

// =============================================================================
// DiagnosticLogger
// =============================================================================

export class DiagnosticLogger {
	private diagnosticSessionId: string;
	private enabled: boolean;
	private persistToStorage: boolean;
	private storageKeyPrefix: string;
	private maxLogs: number;
	private logs: DiagnosticLogEntry[] = [];

	private sendToServer: boolean;
	private serverUrl?: string;
	private clientId?: string;
	private clientSecret?: string;
	private batchSize: number;
	private flushIntervalMs: number;

	private sendBuffer: DiagnosticLogEntry[] = [];
	private flushTimer?: ReturnType<typeof setInterval>;
	private isFlushing = false;

	constructor(options: DiagnosticLoggerOptions) {
		this.enabled = options.enabled;
		this.persistToStorage = options.persistToStorage ?? false;
		this.storageKeyPrefix = options.storageKeyPrefix ?? 'authrim:diagnostic';
		this.maxLogs = options.maxLogs ?? 1000;
		this.sendToServer = options.sendToServer ?? false;
		this.serverUrl = options.serverUrl;
		this.clientId = options.clientId;
		this.clientSecret = options.clientSecret;
		this.batchSize = options.batchSize ?? 50;
		this.flushIntervalMs = options.flushIntervalMs ?? 5000;

		if (this.sendToServer && (!this.serverUrl || !this.clientId)) {
			console.warn(
				'[DiagnosticLogger] sendToServer is enabled but serverUrl or clientId is missing. Server sending disabled.'
			);
			this.sendToServer = false;
		}

		if (options.sessionId) {
			this.diagnosticSessionId = options.sessionId;
		} else {
			this.diagnosticSessionId = this.loadOrGenerateSessionId();
		}

		if (this.persistToStorage) {
			this.loadLogsFromStorage();
		}

		if (this.sendToServer) {
			this.startFlushTimer();
			this.registerUnloadHandlers();
		}
	}

	// ---------------------------------------------------------------------------
	// Public API (compatible with @authrim/web DiagnosticLogger)
	// ---------------------------------------------------------------------------

	getDiagnosticSessionId(): string {
		return this.diagnosticSessionId;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	logTokenValidation(options: {
		step: TokenValidationStep;
		tokenType: string;
		result: 'pass' | 'fail';
		expected?: unknown;
		actual?: unknown;
		errorMessage?: string;
		details?: Record<string, unknown>;
	}): void {
		if (!this.enabled) return;

		const entry: TokenValidationLogEntry = {
			id: this.generateId(),
			diagnosticSessionId: this.diagnosticSessionId,
			category: 'token-validation',
			level: options.result === 'fail' ? 'warn' : 'debug',
			timestamp: Date.now(),
			step: options.step,
			tokenType: options.tokenType,
			result: options.result,
			expected: options.expected,
			actual: options.actual,
			errorMessage: options.errorMessage,
			details: sanitizeDiagnosticValue(options.details) as Record<string, unknown> | undefined
		};

		this.addEntry(entry);
	}

	logAuthDecision(options: {
		decision: 'allow' | 'deny';
		reason: string;
		flow?: string;
		context?: Record<string, unknown>;
	}): void {
		if (!this.enabled) return;

		const entry: AuthDecisionLogEntry = {
			id: this.generateId(),
			diagnosticSessionId: this.diagnosticSessionId,
			category: 'auth-decision',
			level: options.decision === 'deny' ? 'warn' : 'info',
			timestamp: Date.now(),
			decision: options.decision,
			reason: options.reason,
			flow: options.flow,
			context: sanitizeDiagnosticValue(options.context) as Record<string, unknown> | undefined
		};

		this.addEntry(entry);
	}

	getLogs(): DiagnosticLogEntry[] {
		return [...this.logs];
	}

	exportLogs(): string {
		return JSON.stringify(this.logs, null, 2);
	}

	downloadLogs(): void {
		const content = this.exportLogs();
		const blob = new Blob([content], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `diagnostic-${this.diagnosticSessionId}-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	clearLogs(): void {
		this.logs = [];
		this.sendBuffer = [];
		if (this.persistToStorage) {
			this.clearStorage();
		}
	}

	async flush(): Promise<void> {
		if (!this.sendToServer || this.sendBuffer.length === 0 || this.isFlushing) return;
		this.isFlushing = true;

		const batch = this.sendBuffer.splice(0, this.batchSize);
		try {
			await this.sendBatch(batch);
		} catch {
			// Re-queue failed batch at the front
			this.sendBuffer.unshift(...batch);
		} finally {
			this.isFlushing = false;
		}
	}

	flushBeacon(): void {
		if (!this.sendToServer || !this.serverUrl || !this.clientId || this.sendBuffer.length === 0) {
			return;
		}

		const batch = this.sendBuffer.splice(0, this.batchSize);
		const payload = JSON.stringify({
			client_id: this.clientId,
			...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
			logs: batch
		});

		navigator.sendBeacon(this.serverUrl, new Blob([payload], { type: 'application/json' }));
	}

	destroy(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = undefined;
		}
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private addEntry(entry: DiagnosticLogEntry): void {
		if (this.logs.length >= this.maxLogs) {
			this.logs.shift();
		}
		this.logs.push(entry);

		if (this.persistToStorage) {
			this.saveLogsToStorage();
		}

		if (this.sendToServer) {
			this.sendBuffer.push(entry);
			if (this.sendBuffer.length >= this.batchSize) {
				this.flush();
			}
		}
	}

	private async sendBatch(batch: DiagnosticLogEntry[]): Promise<void> {
		if (!this.serverUrl || !this.clientId) return;

		const body: Record<string, unknown> = {
			client_id: this.clientId,
			logs: batch
		};
		if (this.clientSecret) {
			body.client_secret = this.clientSecret;
		}

		const response = await fetch(this.serverUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Diagnostic-Session-Id': this.diagnosticSessionId
			},
			body: JSON.stringify(body),
			keepalive: true
		});

		if (!response.ok) {
			throw new Error(`Ingest failed: ${response.status}`);
		}
	}

	private startFlushTimer(): void {
		this.flushTimer = setInterval(() => {
			this.flush();
		}, this.flushIntervalMs);
	}

	private registerUnloadHandlers(): void {
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				this.flushBeacon();
			}
		});
		window.addEventListener('beforeunload', () => {
			this.flushBeacon();
		});
	}

	private loadOrGenerateSessionId(): string {
		if (this.persistToStorage) {
			const stored = localStorage.getItem(`${this.storageKeyPrefix}:session-id`);
			if (stored) return stored;
		}
		const id = this.generateSessionId();
		if (this.persistToStorage) {
			localStorage.setItem(`${this.storageKeyPrefix}:session-id`, id);
		}
		return id;
	}

	private generateSessionId(): string {
		try {
			return crypto.randomUUID();
		} catch {
			const bytes = crypto.getRandomValues(new Uint8Array(16));
			return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		}
	}

	private generateId(): string {
		try {
			return crypto.randomUUID();
		} catch {
			return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		}
	}

	private saveLogsToStorage(): void {
		try {
			localStorage.setItem(`${this.storageKeyPrefix}:logs`, JSON.stringify(this.logs));
		} catch {
			// Quota exceeded - ignore
		}
	}

	private loadLogsFromStorage(): void {
		try {
			const stored = localStorage.getItem(`${this.storageKeyPrefix}:logs`);
			if (stored) {
				const parsed = JSON.parse(stored) as DiagnosticLogEntry[];
				// Only load logs for the current session
				this.logs = parsed.filter((e) => e.diagnosticSessionId === this.diagnosticSessionId);
			}
		} catch {
			// Corrupted storage - ignore
		}
	}

	private clearStorage(): void {
		try {
			localStorage.removeItem(`${this.storageKeyPrefix}:logs`);
			localStorage.removeItem(`${this.storageKeyPrefix}:session-id`);
		} catch {
			// Ignore
		}
	}
}

const SENSITIVE_DIAGNOSTIC_KEYS = new Set([
	'access_token',
	'refresh_token',
	'id_token',
	'token',
	'authorization',
	'dpop',
	'dpop_proof',
	'client_secret',
	'code_verifier',
	'direct_auth_artifact',
	'handoff_token'
]);

function sanitizeDiagnosticValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeDiagnosticValue(entry));
	}
	if (!value || typeof value !== 'object') {
		return value;
	}

	const sanitized: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		if (SENSITIVE_DIAGNOSTIC_KEYS.has(key.toLowerCase())) {
			sanitized[key] = '[REDACTED]';
			continue;
		}
		sanitized[key] = sanitizeDiagnosticValue(nestedValue);
	}
	return sanitized;
}
