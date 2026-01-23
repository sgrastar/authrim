/**
 * Admin IP Allowlist Management API Client
 *
 * Provides API calls for managing IP-based access control for Admin panel.
 * When the allowlist is empty, all IPs are allowed (default behavior).
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * IP allowlist entry
 */
export interface IpAllowlistEntry {
	id: string;
	tenant_id: string;
	ip_range: string;
	ip_version: 4 | 6 | null;
	description: string | null;
	enabled: boolean;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

/**
 * IP allowlist response
 */
export interface IpAllowlistResponse {
	items: IpAllowlistEntry[];
	total: number;
	current_ip: string;
	restriction_active: boolean;
}

/**
 * Create IP allowlist entry input
 */
export interface CreateIpAllowlistInput {
	ip_range: string;
	description?: string;
	enabled?: boolean;
}

/**
 * Update IP allowlist entry input
 */
export interface UpdateIpAllowlistInput {
	ip_range?: string;
	description?: string;
	enabled?: boolean;
}

/**
 * IP check response
 */
export interface IpCheckResponse {
	ip: string;
	allowed: boolean;
	restriction_active: boolean;
	entry_count: number;
}

/**
 * Admin IP Allowlist API
 */
export const adminIpAllowlistAPI = {
	/**
	 * List all IP allowlist entries
	 * GET /api/admin/ip-allowlist
	 */
	async list(includeDisabled: boolean = false): Promise<IpAllowlistResponse> {
		const params = new URLSearchParams();
		if (includeDisabled) params.set('include_disabled', 'true');

		const queryString = params.toString();
		const url = `${API_BASE_URL}/api/admin/ip-allowlist${queryString ? `?${queryString}` : ''}`;

		const response = await fetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch IP allowlist');
		}

		return response.json();
	},

	/**
	 * Get IP allowlist entry details
	 * GET /api/admin/ip-allowlist/:id
	 */
	async get(id: string): Promise<IpAllowlistEntry> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/ip-allowlist/${encodeURIComponent(id)}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('IP allowlist entry not found');
			}
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch IP allowlist entry');
		}

		return response.json();
	},

	/**
	 * Add a new IP allowlist entry
	 * POST /api/admin/ip-allowlist
	 */
	async create(data: CreateIpAllowlistInput): Promise<IpAllowlistEntry> {
		const response = await fetch(`${API_BASE_URL}/api/admin/ip-allowlist`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create IP allowlist entry');
		}

		return response.json();
	},

	/**
	 * Update an IP allowlist entry
	 * PATCH /api/admin/ip-allowlist/:id
	 */
	async update(id: string, data: UpdateIpAllowlistInput): Promise<IpAllowlistEntry> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/ip-allowlist/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update IP allowlist entry');
		}

		return response.json();
	},

	/**
	 * Delete an IP allowlist entry
	 * DELETE /api/admin/ip-allowlist/:id
	 */
	async delete(id: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/ip-allowlist/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete IP allowlist entry');
		}

		return response.json();
	},

	/**
	 * Enable an IP allowlist entry
	 * POST /api/admin/ip-allowlist/:id/enable
	 */
	async enable(id: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/ip-allowlist/${encodeURIComponent(id)}/enable`,
			{
				method: 'POST',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to enable IP allowlist entry');
		}

		return response.json();
	},

	/**
	 * Disable an IP allowlist entry
	 * POST /api/admin/ip-allowlist/:id/disable
	 */
	async disable(id: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/ip-allowlist/${encodeURIComponent(id)}/disable`,
			{
				method: 'POST',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to disable IP allowlist entry');
		}

		return response.json();
	},

	/**
	 * Check if an IP address is allowed
	 * POST /api/admin/ip-allowlist/check
	 */
	async checkIp(ip: string): Promise<IpCheckResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/ip-allowlist/check`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ ip })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to check IP');
		}

		return response.json();
	}
};

/**
 * Validate IP address or CIDR notation (client-side)
 */
export function validateIpRange(ipRange: string): { valid: boolean; error?: string } {
	const trimmed = ipRange.trim();

	// Check for CIDR notation
	const cidrMatch = trimmed.match(/^(.+)\/(\d+)$/);

	if (cidrMatch) {
		const [, ip, prefixStr] = cidrMatch;
		const prefix = parseInt(prefixStr, 10);

		// IPv6
		if (ip.includes(':')) {
			if (prefix < 0 || prefix > 128) {
				return { valid: false, error: 'IPv6 CIDR prefix must be between 0 and 128' };
			}
			if (!isValidIpv6(ip)) {
				return { valid: false, error: 'Invalid IPv6 address' };
			}
			return { valid: true };
		}

		// IPv4
		if (prefix < 0 || prefix > 32) {
			return { valid: false, error: 'IPv4 CIDR prefix must be between 0 and 32' };
		}
		if (!isValidIpv4(ip)) {
			return { valid: false, error: 'Invalid IPv4 address' };
		}
		return { valid: true };
	}

	// Single IP address
	if (trimmed.includes(':')) {
		if (!isValidIpv6(trimmed)) {
			return { valid: false, error: 'Invalid IPv6 address' };
		}
		return { valid: true };
	}

	if (!isValidIpv4(trimmed)) {
		return { valid: false, error: 'Invalid IPv4 address' };
	}
	return { valid: true };
}

function isValidIpv4(ip: string): boolean {
	const parts = ip.split('.');
	if (parts.length !== 4) return false;

	for (const part of parts) {
		const num = parseInt(part, 10);
		if (isNaN(num) || num < 0 || num > 255) return false;
		if (part !== num.toString()) return false;
	}

	return true;
}

function isValidIpv6(ip: string): boolean {
	const doubleColonCount = (ip.match(/::/g) || []).length;
	if (doubleColonCount > 1) return false;

	const normalized = ip.replace(/^::|::$/g, '');
	const segments = normalized.split(':').filter((s) => s !== '');

	if (doubleColonCount === 0 && segments.length !== 8) return false;
	if (doubleColonCount === 1 && segments.length > 7) return false;

	for (const segment of segments) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return false;
	}

	return true;
}
