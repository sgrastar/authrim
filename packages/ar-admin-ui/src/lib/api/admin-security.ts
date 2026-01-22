/**
 * Admin Security API Client
 *
 * Provides methods for managing security alerts, suspicious activities,
 * threats detection, and IP reputation checks.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Validate IP address format and check if it's private/reserved
 * Uses a simpler approach to avoid ReDoS vulnerabilities
 */
function validateIPAddress(ip: string): { valid: boolean; isPrivate: boolean } {
	if (!ip || typeof ip !== 'string') {
		return { valid: false, isPrivate: false };
	}

	// Trim and check length to prevent DoS
	const trimmed = ip.trim();
	if (trimmed.length > 45) {
		// Max IPv6 length is 45 characters
		return { valid: false, isPrivate: false };
	}

	// Check for IPv4
	if (trimmed.includes('.') && !trimmed.includes(':')) {
		const parts = trimmed.split('.');
		if (parts.length !== 4) {
			return { valid: false, isPrivate: false };
		}

		for (const part of parts) {
			const num = parseInt(part, 10);
			if (isNaN(num) || num < 0 || num > 255 || part !== num.toString()) {
				return { valid: false, isPrivate: false };
			}
		}

		// Check for private/reserved IPv4 ranges
		const firstOctet = parseInt(parts[0], 10);
		const secondOctet = parseInt(parts[1], 10);
		const isPrivate =
			firstOctet === 10 || // 10.0.0.0/8
			firstOctet === 127 || // 127.0.0.0/8 (loopback)
			firstOctet === 0 || // 0.0.0.0/8
			(firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) || // 172.16.0.0/12
			(firstOctet === 192 && secondOctet === 168) || // 192.168.0.0/16
			(firstOctet === 169 && secondOctet === 254) || // 169.254.0.0/16 (link-local)
			firstOctet >= 224; // 224.0.0.0+ (multicast and reserved)

		return { valid: true, isPrivate };
	}

	// Check for IPv6
	if (trimmed.includes(':')) {
		// Basic IPv6 validation - check for valid characters and structure
		const validChars = /^[0-9a-fA-F:]+$/;
		if (!validChars.test(trimmed)) {
			return { valid: false, isPrivate: false };
		}

		// Count colons and check for valid structure
		const colonCount = (trimmed.match(/:/g) || []).length;
		const doubleColonCount = (trimmed.match(/::/g) || []).length;

		// Must have at least 2 colons, max 7 (or 1 :: which replaces multiple groups)
		if (colonCount < 2 || colonCount > 7) {
			return { valid: false, isPrivate: false };
		}

		// Only one :: is allowed
		if (doubleColonCount > 1) {
			return { valid: false, isPrivate: false };
		}

		// Check each group
		const groups = trimmed.split(':');
		for (const group of groups) {
			if (group.length > 4) {
				return { valid: false, isPrivate: false };
			}
		}

		// Check for private/reserved IPv6 addresses
		const lowerIP = trimmed.toLowerCase();
		const isPrivate =
			lowerIP === '::1' || // loopback
			lowerIP === '::' || // unspecified
			lowerIP.startsWith('fc') || // unique local (fc00::/7)
			lowerIP.startsWith('fd') || // unique local (fc00::/7)
			lowerIP.startsWith('fe80'); // link-local (fe80::/10)

		return { valid: true, isPrivate };
	}

	return { valid: false, isPrivate: false };
}

/**
 * Handle API errors safely - avoid leaking internal error details in production
 */
async function handleAPIError(response: Response, fallbackMessage: string): Promise<Error> {
	try {
		const errorBody = await response.json();
		// In development, show detailed error; in production, use fallback
		if (import.meta.env.DEV) {
			return new Error(errorBody.error_description || errorBody.error || fallbackMessage);
		}
	} catch {
		// JSON parsing failed, use fallback
	}
	return new Error(fallbackMessage);
}

/**
 * Security alert types
 */
export type AlertType =
	| 'brute_force'
	| 'credential_stuffing'
	| 'suspicious_login'
	| 'impossible_travel'
	| 'account_takeover'
	| 'mfa_bypass_attempt'
	| 'token_abuse'
	| 'rate_limit_exceeded'
	| 'config_change'
	| 'privilege_escalation'
	| 'data_exfiltration';

/**
 * Alert severity levels
 */
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Alert status
 */
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

/**
 * Security alert entry
 */
export interface SecurityAlert {
	id: string;
	tenant_id: string;
	type: AlertType;
	severity: AlertSeverity;
	status: AlertStatus;
	title: string;
	description: string;
	source_ip?: string;
	user_id?: string;
	user_email?: string;
	client_id?: string;
	metadata?: Record<string, unknown>;
	created_at: string;
	updated_at: string;
	acknowledged_by?: string;
	acknowledged_at?: string;
	resolved_by?: string;
	resolved_at?: string;
}

/**
 * Suspicious activity types
 */
export type SuspiciousActivityType =
	| 'unusual_login_time'
	| 'new_device'
	| 'new_location'
	| 'failed_mfa'
	| 'password_spray'
	| 'session_hijacking'
	| 'unusual_api_usage'
	| 'excessive_permissions'
	| 'data_access_anomaly';

/**
 * Suspicious activity entry
 */
export interface SuspiciousActivity {
	id: string;
	tenant_id: string;
	type: SuspiciousActivityType;
	severity: AlertSeverity;
	user_id?: string;
	user_email?: string;
	source_ip?: string;
	description: string;
	risk_score: number;
	detected_at: string;
	metadata?: Record<string, unknown>;
}

/**
 * Threat types
 */
export type ThreatType =
	| 'malware'
	| 'phishing'
	| 'ransomware'
	| 'ddos'
	| 'sql_injection'
	| 'xss'
	| 'credential_theft'
	| 'insider_threat'
	| 'apt'
	| 'zero_day';

/**
 * Threat status
 */
export type ThreatStatus = 'detected' | 'investigating' | 'mitigated' | 'false_positive';

/**
 * Security threat entry
 */
export interface SecurityThreat {
	id: string;
	tenant_id: string;
	type: ThreatType;
	severity: AlertSeverity;
	status: ThreatStatus;
	title: string;
	description: string;
	source?: string;
	indicators?: string[];
	detected_at: string;
	mitigated_at?: string;
	metadata?: Record<string, unknown>;
}

/**
 * IP reputation check result
 */
export interface IPReputationResult {
	ip: string;
	risk_level: 'low' | 'medium' | 'high' | 'critical';
	risk_score: number;
	is_blocked: boolean;
	failed_auth_attempts_24h: number;
	rate_limit_violations_24h: number;
	recommendations: string[];
	checked_at: string;
}

/**
 * List response with cursor pagination
 */
export interface ListResponse<T> {
	data: T[];
	has_more: boolean;
	next_cursor?: string;
}

/**
 * Admin Security API
 */
export const adminSecurityAPI = {
	/**
	 * List security alerts
	 */
	async listAlerts(params?: {
		limit?: number;
		cursor?: string;
		status?: AlertStatus;
		severity?: AlertSeverity;
		type?: AlertType;
	}): Promise<ListResponse<SecurityAlert>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.cursor) searchParams.set('cursor', params.cursor);

		const filters: string[] = [];
		if (params?.status) filters.push(`status=${params.status}`);
		if (params?.severity) filters.push(`severity=${params.severity}`);
		if (params?.type) filters.push(`type=${params.type}`);
		if (filters.length > 0) searchParams.set('filter', filters.join(','));

		const url = `${API_BASE_URL}/api/admin/security/alerts${searchParams.toString() ? '?' + searchParams.toString() : ''}`;

		const response = await fetch(url, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list alerts');
		}

		return response.json();
	},

	/**
	 * Acknowledge a security alert
	 */
	async acknowledgeAlert(alertId: string): Promise<SecurityAlert> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/security/alerts/${alertId}/acknowledge`,
			{
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json'
				}
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to acknowledge alert');
		}

		return response.json();
	},

	/**
	 * List suspicious activities
	 */
	async listSuspiciousActivities(params?: {
		limit?: number;
		cursor?: string;
		severity?: AlertSeverity;
		type?: SuspiciousActivityType;
		user_id?: string;
	}): Promise<ListResponse<SuspiciousActivity>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.cursor) searchParams.set('cursor', params.cursor);

		const filters: string[] = [];
		if (params?.severity) filters.push(`severity=${params.severity}`);
		if (params?.type) filters.push(`type=${params.type}`);
		if (params?.user_id) filters.push(`user_id=${params.user_id}`);
		if (filters.length > 0) searchParams.set('filter', filters.join(','));

		const url = `${API_BASE_URL}/api/admin/security/suspicious-activities${searchParams.toString() ? '?' + searchParams.toString() : ''}`;

		const response = await fetch(url, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list suspicious activities');
		}

		return response.json();
	},

	/**
	 * List detected threats
	 */
	async listThreats(params?: {
		limit?: number;
		cursor?: string;
		status?: ThreatStatus;
		severity?: AlertSeverity;
		type?: ThreatType;
	}): Promise<ListResponse<SecurityThreat>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.cursor) searchParams.set('cursor', params.cursor);

		const filters: string[] = [];
		if (params?.status) filters.push(`status=${params.status}`);
		if (params?.severity) filters.push(`severity=${params.severity}`);
		if (params?.type) filters.push(`type=${params.type}`);
		if (filters.length > 0) searchParams.set('filter', filters.join(','));

		const url = `${API_BASE_URL}/api/admin/security/threats${searchParams.toString() ? '?' + searchParams.toString() : ''}`;

		const response = await fetch(url, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list threats');
		}

		return response.json();
	},

	/**
	 * Check IP reputation
	 */
	async checkIPReputation(ip: string): Promise<IPReputationResult> {
		// Validate IP address format using a simpler, safer approach
		const isValidIP = validateIPAddress(ip);
		if (!isValidIP.valid) {
			throw new Error('Invalid IP address format');
		}

		// Reject private/reserved IP addresses to prevent SSRF
		if (isValidIP.isPrivate) {
			throw new Error('Private or reserved IP addresses are not allowed');
		}

		const response = await fetch(`${API_BASE_URL}/api/admin/security/ip-reputation`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ ip })
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to check IP reputation');
		}

		return response.json();
	}
};

/**
 * Get severity badge color
 */
export function getSeverityColor(severity: AlertSeverity): string {
	switch (severity) {
		case 'critical':
			return '#dc2626';
		case 'high':
			return '#ea580c';
		case 'medium':
			return '#d97706';
		case 'low':
			return '#65a30d';
		case 'info':
			return '#0284c7';
		default:
			return '#6b7280';
	}
}

/**
 * Get status badge color
 */
export function getAlertStatusColor(status: AlertStatus): string {
	switch (status) {
		case 'open':
			return '#ef4444';
		case 'acknowledged':
			return '#f59e0b';
		case 'resolved':
			return '#22c55e';
		case 'dismissed':
			return '#6b7280';
		default:
			return '#6b7280';
	}
}

/**
 * Get risk level color
 */
export function getRiskLevelColor(level: IPReputationResult['risk_level']): string {
	switch (level) {
		case 'critical':
			return '#dc2626';
		case 'high':
			return '#ea580c';
		case 'medium':
			return '#d97706';
		case 'low':
			return '#22c55e';
		default:
			return '#6b7280';
	}
}

/**
 * Get alert type display name
 */
export function getAlertTypeDisplayName(type: AlertType): string {
	const names: Record<AlertType, string> = {
		brute_force: 'Brute Force',
		credential_stuffing: 'Credential Stuffing',
		suspicious_login: 'Suspicious Login',
		impossible_travel: 'Impossible Travel',
		account_takeover: 'Account Takeover',
		mfa_bypass_attempt: 'MFA Bypass Attempt',
		token_abuse: 'Token Abuse',
		rate_limit_exceeded: 'Rate Limit Exceeded',
		config_change: 'Config Change',
		privilege_escalation: 'Privilege Escalation',
		data_exfiltration: 'Data Exfiltration'
	};
	return names[type] || 'Unknown Alert Type';
}

/**
 * Get threat type display name
 */
export function getThreatTypeDisplayName(type: ThreatType): string {
	const names: Record<ThreatType, string> = {
		malware: 'Malware',
		phishing: 'Phishing',
		ransomware: 'Ransomware',
		ddos: 'DDoS Attack',
		sql_injection: 'SQL Injection',
		xss: 'Cross-Site Scripting',
		credential_theft: 'Credential Theft',
		insider_threat: 'Insider Threat',
		apt: 'Advanced Persistent Threat',
		zero_day: 'Zero-Day Exploit'
	};
	return names[type] || 'Unknown Threat Type';
}
