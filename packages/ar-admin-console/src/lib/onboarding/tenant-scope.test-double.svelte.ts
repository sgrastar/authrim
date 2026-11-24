/** A tenant scope whose tenant is reactive and can be set, for the tests of what follows it. */
let tenantId = $state<string | null>('tenant-a');

export const tenantScope = {
	get tenantId(): string | null {
		return tenantId;
	},
	select(id: string | null): void {
		tenantId = id;
	}
};
