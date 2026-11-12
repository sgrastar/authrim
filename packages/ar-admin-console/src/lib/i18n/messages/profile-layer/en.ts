import type { jaProfileLayer } from './ja';

export const enProfileLayer: { [K in keyof typeof jaProfileLayer]: string } = {
	'pl.platform': 'Platform',
	'pl.overridden': 'Overridden',
	'pl.inactive': 'Override set aside',
	'pl.locked': 'Locked',
	'pl.updated': 'Platform updated',
	'pl.copyNote':
		"This profile belongs to the platform. Saving makes a copy for this tenant; the platform's values stay as they are.",
	'pl.copyActive':
		"This tenant uses its own copy. Going back to the platform's values removes the copy.",
	'pl.defaultNote':
		"The platform's values sit under Default: a setting this tenant does not set takes the platform's value. Saving keeps the values shown as this tenant's own copy.",
	'pl.readOnlyLocked':
		"The platform has locked this, so it cannot be changed here. The values shown are the platform's.",
	'pl.readOnlyNotAllowed':
		"The platform does not let tenants change this, so it cannot be changed here. The values shown are the platform's.",
	'pl.readOnly': 'This profile cannot be changed right now.',
	'pl.copyKept':
		"This tenant's copy is kept, not deleted: it applies again once the platform allows it.",
	'pl.updatedNote':
		"The platform changed this since this tenant's copy was made. To take its new values, go back to the platform's values.",
	'pl.revert': "Use the platform's values",
	'pl.revertTitle': "Use the platform's values for {name}?",
	'pl.revertBody':
		"The values changed for this tenant are removed and the platform's values apply.",
	'pl.revertSuccess': "Now using the platform's values",
	'pl.revertFailed': "Could not go back to the platform's values",
	'pl.notEditable': 'The platform does not allow this change, so it was not saved',
	'pl.creationNotAllowed': 'The platform does not let tenants add profiles of their own.',
	'pl.optionPlatform': '{name} (platform)'
};
