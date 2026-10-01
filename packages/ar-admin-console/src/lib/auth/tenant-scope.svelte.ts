/**
 * Which tenant tenant-scoped pages operate on. Sent to the Admin API as X-Tenant-Id by
 * admin-request.ts. Platform administrators can pick any tenant; tenant administrators only
 * ever see their own, so the switcher offers no choice to them.
 */
import { adminFetch, API_BASE_URL } from '$lib/api/admin-request';

export interface TenantRef {
	id: string;
	name: string;
}

const STORAGE_KEY = 'authrim-console-tenant';

function readStored(): string | null {
	try {
		return sessionStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeStored(id: string): void {
	try {
		sessionStorage.setItem(STORAGE_KEY, id);
	} catch {
		// Storage blocked: the selection lasts for this page only.
	}
}

let tenantId = $state<string | null>(null);
let tenants = $state<TenantRef[]>([]);

export const tenantScope = {
	get tenantId(): string | null {
		return tenantId;
	},
	get tenants(): readonly TenantRef[] {
		return tenants;
	},
	get current(): TenantRef | null {
		return (
			tenants.find((t) => t.id === tenantId) ?? (tenantId ? { id: tenantId, name: tenantId } : null)
		);
	},

	/**
	 * Loads the tenants this administrator can operate on. `homeTenantId` is the tenant of the
	 * session, used when the list is unavailable (tenant administrators).
	 */
	async load(homeTenantId: string | null, canListAll: boolean): Promise<void> {
		let list: TenantRef[] = [];
		if (canListAll) {
			try {
				const response = await adminFetch(`${API_BASE_URL}/api/admin/tenants`, {
					skipTenantHeader: true
				});
				if (response.ok) {
					const data = (await response.json()) as {
						tenants?: Array<{ id: string; name?: string }>;
					};
					list = (data.tenants ?? []).map((t) => ({ id: t.id, name: t.name || t.id }));
				}
			} catch {
				list = [];
			}
		}
		if (list.length === 0 && homeTenantId) list = [{ id: homeTenantId, name: homeTenantId }];
		tenants = list;
		const stored = readStored();
		const next = list.find((t) => t.id === stored)?.id ?? list[0]?.id ?? homeTenantId;
		tenantId = next ?? null;
		if (next) writeStored(next);
	},

	select(id: string): void {
		if (!tenants.some((t) => t.id === id)) return;
		tenantId = id;
		writeStored(id);
	}
};
