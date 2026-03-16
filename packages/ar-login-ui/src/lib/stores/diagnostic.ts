/**
 * Diagnostic Logger Store
 *
 * Singleton DiagnosticLogger instance initialized from environment variables.
 * Enabled only when PUBLIC_DIAGNOSTIC_LOGGING_ENABLED=true.
 */

import { browser } from '$app/environment';
import { DiagnosticLogger } from '$lib/diagnostic/diagnostic-logger';

let _logger: DiagnosticLogger | null = null;

/**
 * Get the singleton DiagnosticLogger instance.
 * Returns null if diagnostic logging is disabled or running server-side.
 */
export function getDiagnosticLogger(): DiagnosticLogger | null {
	if (!browser) return null;
	if (_logger) return _logger;

	const enabled = import.meta.env.PUBLIC_DIAGNOSTIC_LOGGING_ENABLED === 'true';
	if (!enabled) return null;

	const clientId = import.meta.env.PUBLIC_LOGIN_UI_CLIENT_ID as string | undefined;
	const issuer =
		(import.meta.env.PUBLIC_AUTHRIM_ISSUER as string | undefined) || window.location.origin;

	_logger = new DiagnosticLogger({
		enabled: true,
		persistToStorage: true,
		sendToServer: !!clientId,
		serverUrl: `${issuer}/api/v1/diagnostic-logs/ingest`,
		clientId,
		batchSize: 50,
		flushIntervalMs: 5000
	});

	return _logger;
}

/**
 * Get the current diagnostic session ID.
 * Returns null if diagnostic logging is disabled.
 */
export function getDiagnosticSessionId(): string | null {
	return getDiagnosticLogger()?.getDiagnosticSessionId() ?? null;
}
