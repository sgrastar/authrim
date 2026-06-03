/**
 * Tenant Store (Svelte 5 Runes)
 *
 * Shared reactive state for the tenant list.
 * Used by +layout.svelte (AdminHeader selector) and
 * admin/tenants/+page.svelte (management page) to stay in sync.
 */

import { adminTenantsAPI, type Tenant, type TenantListResponse } from '$lib/api/admin-tenants';

function createTenantStore() {
	let tenants = $state<Tenant[]>([]);
	let tenantD1Pool = $state<TenantListResponse['tenant_d1_pool']>({ enabled: false });
	let loaded = $state(false);
	let singleTenantMode = $state(false);
	let singleTenantReason = $state<string | null>(null);

	return {
		get tenants() {
			return tenants;
		},
		get loaded() {
			return loaded;
		},
		get singleTenantMode() {
			return singleTenantMode;
		},
		get singleTenantReason() {
			return singleTenantReason;
		},
		get tenantD1Pool() {
			return tenantD1Pool;
		},

		/** Active tenants suitable for the header selector */
		get activeTenants(): { id: string; name: string }[] {
			return tenants
				.filter((t) => t.lifecycle_state === 'active')
				.map((t) => ({ id: t.id, name: t.name }));
		},

		/** The current default tenant id */
		get defaultTenantId(): string {
			return tenants.find((t) => t.is_default)?.id ?? tenants[0]?.id ?? '';
		},

		/** Fetch the full tenant list from the API */
		async load() {
			try {
				const response = await adminTenantsAPI.list();
				tenants = response.tenants;
				tenantD1Pool = response.tenant_d1_pool ?? { enabled: false };
				singleTenantMode = response.single_tenant_mode ?? false;
				singleTenantReason = response.single_tenant_reason ?? null;
				loaded = true;
			} catch {
				// Non-critical: selector simply won't appear
			}
		},

		/** Reload the tenant list (e.g. after create/update/delete operations) */
		async reload() {
			await this.load();
		},

		/** Optimistically update a single tenant in the list */
		update(updated: Tenant) {
			tenants = tenants.map((t) => (t.id === updated.id ? updated : t));
		},

		/** Optimistically add a tenant to the list */
		add(tenant: Tenant) {
			tenants = [...tenants, tenant].sort((a, b) => {
				if (a.is_default) return -1;
				if (b.is_default) return 1;
				return a.name.localeCompare(b.name);
			});
		},

		/** Optimistically remove a tenant from the list */
		remove(id: string) {
			tenants = tenants.filter((t) => t.id !== id);
		},

		/** Mark a tenant as default and clear the flag from all others */
		setDefault(id: string) {
			tenants = tenants.map((t) => ({ ...t, is_default: t.id === id }));
		}
	};
}

export const tenantStore = createTenantStore();
