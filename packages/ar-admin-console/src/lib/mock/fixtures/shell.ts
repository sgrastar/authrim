import type { ScopeOption } from '#lib/shell/ScopeSwitcher.svelte';

/** What the shell frame shows around a mock page. Sample data only. */
export const mockScopes: ScopeOption[] = [
	{ id: 'platform', kind: 'platform', name: 'Whole platform', mark: '◆' },
	{ id: 'acme', kind: 'tenant', name: 'Acme Corporation', mark: 'A' },
	{ id: 'globex', kind: 'tenant', name: 'Globex Inc.', mark: 'G' }
];

export const mockAccount = { name: 'Alex Morgan', email: 'admin@example.com', initials: 'AM' };
