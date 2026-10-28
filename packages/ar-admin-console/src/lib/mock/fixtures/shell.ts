import type { ScopeOption } from '$lib/shell/ScopeSwitcher.svelte';
import type { ShellNotification } from '$lib/shell/notifications';

/** What the shell frame shows around a mock page. Sample data only. */
export const mockScopes: ScopeOption[] = [
	{ id: 'platform', kind: 'platform', name: 'Whole platform', mark: '◆' },
	{ id: 'acme', kind: 'tenant', name: 'Acme Corporation', mark: 'A' },
	{ id: 'globex', kind: 'tenant', name: 'Globex Inc.', mark: 'G' }
];

export const mockAccount = { name: 'Alex Morgan', email: 'admin@example.com', initials: 'AM' };

export const mockNotifications: ShellNotification[] = [
	{
		id: 'n1',
		severity: 'critical',
		text: 'A signing certificate expires in 6 days.',
		time: '08:15'
	},
	{
		id: 'n2',
		severity: 'high',
		text: 'A directory connection has failed for 12 minutes.',
		time: '12:04'
	},
	{
		id: 'n3',
		severity: 'caution',
		text: 'The sync with the secondary system is 40 minutes behind.',
		time: 'Yesterday'
	},
	{ id: 'n4', severity: 'info', text: 'A weekly backup finished.', time: '09:30' },
	{ id: 'n5', severity: 'info', text: 'A new administrator joined the tenant.', time: 'Yesterday' }
];
