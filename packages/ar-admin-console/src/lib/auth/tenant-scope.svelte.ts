/**
 * Which tenant tenant-scoped pages operate on. Sent to the Admin API as X-Tenant-Id by
 * admin-request.ts. Platform administrators can pick any tenant; tenant administrators only
 * ever see their own, so the switcher offers no choice to them.
 */
import { adminFetch, API_BASE_URL } from '#lib/api/admin-request.js';

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
/** What the last `load` was given, so `reload` can read the list again. */
let lastLoad: { homeTenantId: string | null; canListAll: boolean } | null = null;

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
		lastLoad = { homeTenantId, canListAll };
		let list: TenantRef[] = [];
		if (canListAll) {
			try {
				const response = await adminFetch(`${API_BASE_URL}/api/admin/tenants`, {
					skipTenantHeader: true
				});
				if (response.ok) {
					const data = (await response.json()) as {
						tenants?: Array<{ id: string; name?: string; lifecycle_state?: string }>;
					};
					// A tenant being deleted (or gone) can no longer be worked on.
					list = (data.tenants ?? [])
						.filter((t) => t.lifecycle_state !== 'deleting' && t.lifecycle_state !== 'deleted')
						.map((t) => ({ id: t.id, name: t.name || t.id }));
				}
			} catch {
				list = [];
			}
		}
		if (list.length === 0 && homeTenantId) list = [{ id: homeTenantId, name: homeTenantId }];
		tenants = list;
		// The selection of this page first (storage may be blocked), then the stored one.
		const next =
			[tenantId, readStored()].find((id) => id && list.some((t) => t.id === id)) ??
			list[0]?.id ??
			homeTenantId;
		tenantId = next ?? null;
		if (next) writeStored(next);
	},

	/**
	 * Reads the list again (a tenant was created, copied or deleted). The selection is kept while
	 * the tenant is still listed.
	 */
	async reload(): Promise<void> {
		if (lastLoad) await this.load(lastLoad.homeTenantId, lastLoad.canListAll);
	},

	select(id: string): void {
		if (!tenants.some((t) => t.id === id)) return;
		tenantId = id;
		writeStored(id);
	}
};
