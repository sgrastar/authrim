import type { jaPlatformProfiles } from './ja';

export const enPlatformProfiles: { [K in keyof typeof jaPlatformProfiles]: string } = {
	'pp.title.method': 'Platform method profiles',
	'pp.title.session': 'Platform session profiles',
	'pp.desc.method':
		"Sign-in method profiles every tenant can use, and the platform's Default that sits under each tenant's Default.",
	'pp.desc.session':
		"Session profiles every tenant can use, and the platform's Default that sits under each tenant's Default.",
	'pp.tab.profiles': 'Profiles',
	'pp.tab.default': 'Default and permissions',
	'pp.list.name': 'Profile name',
	'pp.list.overriding': 'Tenant copies',
	'pp.list.overridingCount': '{count} tenants',
	'pp.list.updated': 'Updated',
	'pp.list.actions': 'Actions for {name}',
	'pp.list.open': 'Open {name}',
	'pp.list.create': 'Create profile',
	'pp.list.empty': 'No platform profiles yet',
	'pp.list.lock': 'Lock',
	'pp.list.unlock': 'Unlock',
	'pp.list.locked': "Locked. Tenants' copies no longer apply (they are kept).",
	'pp.list.unlocked': "Unlocked. Tenants' copies apply again.",
	'pp.list.delete': 'Delete',
	'pp.list.deleteTitle': 'Delete {name}?',
	'pp.list.deleteBody':
		"It will no longer be available to any tenant. It cannot be deleted while a tenant's service flow uses it. Tenants' copies stop applying too.",
	'pp.list.deleteSuccess': 'Deleted',
	'pp.list.inUse':
		"A tenant's service flow uses it, so it cannot be deleted. Choose another profile in that flow first.",
	'pp.list.checkIncomplete':
		'Not every tenant could be checked for it, so it was not deleted. Try again.',
	'pp.list.deleting': 'Deleting',
	'pp.list.failed': 'The action failed',
	'pp.page.new': 'New platform profile',
	'pp.page.back': 'Platform profiles',
	'pp.page.name': 'Name',
	'pp.page.nameHint': 'Tenants see it under this name too.',
	'pp.page.nameRequired': 'Enter a name',
	'pp.page.nameTaken': 'A platform profile has this name already',
	'pp.page.limitReached':
		'The platform has as many profiles as it may hold. Delete one it no longer uses.',
	'pp.page.saved': 'Profile saved',
	'pp.page.saveFailed': 'Could not save',
	'pp.page.conflict': 'Someone else changed it first. Reload and try again.',
	'pp.page.notFound': 'This profile was not found',
	'pp.page.noAccess': "You may not see the platform's profiles",
	'pp.page.loadFailed': 'Could not load',
	'pp.page.overriding':
		'{count} tenants keep a copy of this profile. Saving does not change their copies (each sees "Platform updated").',
	'pp.page.lockedNote': "Locked: tenants' copies do not apply, and tenants cannot change it.",
	'pp.page.deletingNote': 'It is being deleted, so it cannot be changed.',
	'pp.default.method': "The platform's Default methods",
	'pp.default.method.desc':
		"Used where a tenant sets nothing. While locked, or while tenants may not change profiles, used instead of the tenant's values.",
	'pp.default.session': "The platform's Default session rules",
	'pp.switches': 'What tenants may do',
	'pp.switches.desc':
		"Whether tenants may change the platform's profiles, add their own, and change their Default. Turning one off applies to every tenant at once."
};
