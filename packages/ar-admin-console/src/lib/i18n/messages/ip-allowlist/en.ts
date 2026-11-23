import type { jaIpAllowlist } from './ja';

export const enIpAllowlist: Record<keyof typeof jaIpAllowlist, string> = {
	'ip.page.desc':
		'Limit the IP addresses that can reach the admin console and the Admin API. It applies to this tenant’s administrators and does not affect end users’ sign-in.',
	'ip.add': 'Add IP',
	'ip.check': 'Check an IP',

	'ip.status.open.title': 'No IP limit is set',
	'ip.status.open.body':
		'Administrators can sign in from any IP address. Once you add an enabled entry, only addresses in its range can.',
	'ip.status.active.title': 'The IP limit is on',
	'ip.status.active.body':
		'Only addresses in an enabled entry’s range can reach the admin console and the Admin API.',
	'ip.you.label': 'Your IP address',
	'ip.you.allowed': 'Allowed',
	'ip.you.blocked': 'Not allowed',
	'ip.you.unknown': 'Cannot tell',
	'ip.you.none': 'Your IP address could not be read.',
	'ip.you.ipv6':
		'This is an IPv6 address. An IPv4 range does not allow it, and this page adds IPv4 ranges only.',

	'ip.list.title': 'Listed IP addresses',
	'ip.col.range': 'IP address or range',
	'ip.col.size': 'Covers',
	'ip.col.status': 'Status',
	'ip.col.created': 'Added',
	'ip.col.actions': 'Actions',
	'ip.col.actionsFor': 'Actions for {range}',
	'ip.size.single': 'One address',
	'ip.size.range': '{count} addresses',
	'ip.size.ipv6': 'IPv6',
	'ip.on': 'On',
	'ip.off': 'Off',
	'ip.mine': 'Includes your IP',
	'ip.empty.title': 'Nothing is listed yet',
	'ip.empty.body': 'Add an IP address or a range to turn the IP limit on.',
	'ip.noAccess': 'You do not have access to the IP limit.',
	'ip.loadFailed': 'Could not load the IP limit.',

	'ip.action.edit': 'Edit',
	'ip.action.enable': 'Turn on',
	'ip.action.disable': 'Turn off',
	'ip.action.delete': 'Delete',

	'ip.new.title': 'Add IP',
	'ip.new.submit': 'Add',
	'ip.edit.title': 'Edit IP',
	'ip.edit.submit': 'Save',
	'ip.field.range': 'IP address or range',
	'ip.field.rangeHint':
		'Enter one IPv4 address (203.0.113.5) or a range in CIDR form (203.0.113.0/24).',
	'ip.field.rangeIpv6':
		'An IPv6 entry cannot be changed on this page. You can change its description, turn it off or delete it.',
	'ip.field.description': 'Description (optional)',
	'ip.field.descriptionPlaceholder': 'For example: Head office network',
	'ip.useMine': 'Use my IP',
	'ip.preview.single': 'This one address is covered.',
	'ip.preview.range': '{first} to {last} ({count} addresses) are covered.',
	'ip.preview.all': 'Every IPv4 address is covered.',
	'ip.preview.normalized': 'It is saved as {range}.',
	'ip.preview.mine': 'It includes your IP address.',
	'ip.preview.notMine': 'It does not include your IP address.',

	'ip.err.empty': 'Enter an IP address or a range.',
	'ip.err.address':
		'That is not an IPv4 address. Enter four numbers from 0 to 255, separated by dots.',
	'ip.err.prefix': 'The range length is 0 to 32 (for example /24).',
	'ip.err.ipv6': 'IPv6 cannot be added on this page. Enter an IPv4 address.',
	'ip.err.duplicate': 'That range is already listed.',
	'ip.err.invalid': 'The server did not accept this value. Check what you entered.',
	'ip.err.forbidden': 'You are not allowed to do this.',
	'ip.err.notFound': 'This entry was already deleted. The list is loaded again.',
	'ip.err.generic': 'Could not save. Try again.',

	'ip.lock.title': 'You would be locked out',
	'ip.lock.body':
		'After this change your IP address ({ip}) is not in an allowed range. Once saved, you cannot reach the admin console from this address.',
	'ip.lock.bodyNoIp':
		'After this change your IP address may not be in an allowed range. Once saved, you may not be able to reach the admin console.',
	'ip.lock.ipv6': 'An IPv6 address cannot be allowed by an IPv4 range.',
	'ip.lock.confirm': 'Continue anyway',

	'ip.delete.title': 'Delete {range}?',
	'ip.delete.body': 'This deletes the entry. It cannot be undone.',
	'ip.delete.last':
		'No enabled entry will be left, so the IP limit is lifted and every IP address can sign in.',
	'ip.delete.confirm': 'Delete',

	'ip.check.title': 'Check an IP',
	'ip.check.desc':
		'See whether an IP address could reach the admin console under the enabled entries.',
	'ip.check.field': 'IP address',
	'ip.check.submit': 'Check',
	'ip.check.allowed': '{ip} is allowed.',
	'ip.check.blocked': '{ip} is not allowed.',
	'ip.check.open': 'No IP limit is set, so every IP address is allowed.',
	'ip.check.invalid': 'Enter one IPv4 address.',

	'ip.toast.added': 'IP added.',
	'ip.toast.saved': 'Changes saved.',
	'ip.toast.enabled': 'Turned on.',
	'ip.toast.disabled': 'Turned off.',
	'ip.toast.deleted': 'Deleted.'
};
