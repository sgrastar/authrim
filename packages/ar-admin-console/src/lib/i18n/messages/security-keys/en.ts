import type { jaSecurityKeys } from './ja';

export const enSecurityKeys: Record<keyof typeof jaSecurityKeys, string> = {
	'sk.title': 'Security keys',
	'sk.info':
		'Keys confirmed in addition to your passkey before sensitive operations. Only keys that do not sync (USB or NFC security keys) can be registered. They are not used to sign in.',
	'sk.add': 'Add security key',
	'sk.addTitle': 'Add a security key',
	'sk.addBody': 'Give it a name so you can tell it apart later.',
	'sk.name': 'Name',
	'sk.nameHint': 'For example: YubiKey (blue)',
	'sk.register': 'Register key',
	'sk.unnamed': 'Unnamed',
	'sk.recovery.soleAdmin':
		'You are the only administrator, so you cannot request a recovery here. Recover with the environment owner procedure (last-resort recovery).',
	'sk.onlyOne.title': 'You have only one second factor',
	'sk.onlyOne.body':
		'If you lose it, you cannot perform sensitive operations. We recommend registering another security key or Keyring.',
	'sk.only': 'Only key',
	'sk.created': 'Registered',
	'sk.lastUsed': 'Last used',
	'sk.never': 'Never',
	'sk.revoked': 'Revoked',
	'sk.remove': 'Remove',
	'sk.removeTitle': 'Remove “{name}”?',
	'sk.removeBody': 'This key can no longer be used to confirm operations.',
	'sk.added': 'The security key was added.',
	'sk.removed': 'The security key was removed.',
	'sk.loadFailed': 'Security keys could not be loaded.',
	'sk.empty': 'No security keys',
	'sk.first.title': 'Register your first key by {date}',
	'sk.first.body': 'Until then, confirming your passkey is enough to register the first key.',
	'sk.recoveryNeeded.title': 'Registering a key needs a recovery request',
	'sk.recoveryNeeded.body':
		'The period for registering a first key has ended. Request recovery with a new key; it can be completed after 24 hours.',
	'sk.recover': 'Request recovery',
	'sk.recoverTitle': 'Request key recovery',
	'sk.recoverBody':
		'Register a new key to file the request. You and every administrator of the tenant are emailed, and it can be completed after 24 hours. Completing it revokes all your current keys and ends your other sessions.',
	'sk.recoverSubmit': 'Register key and request',
	'sk.recoveryFiled': 'Recovery was requested.',
	'sk.recovery.waiting.title': 'Recovery requested',
	'sk.recovery.waiting.body':
		'It can be completed after {date}. Until then, you or another administrator can cancel it.',
	'sk.recovery.ready.title': 'Recovery can be completed',
	'sk.recovery.ready.body':
		'Completing it revokes all your current keys and ends your other sessions.',
	'sk.recovery.complete': 'Complete recovery',
	'sk.recovery.completeTitle': 'Complete recovery?',
	'sk.recovery.completed': 'Recovery was completed.',
	'sk.recovery.cancel': 'Cancel request',
	'sk.recovery.cancelTitle': 'Cancel the recovery request?',
	'sk.recovery.cancelBody': 'The key you registered for it will not be added.',
	'sk.recovery.cancelled': 'The recovery request was cancelled.',
	'sk.error': 'The security key could not be changed. Please try again.',
	'sk.error.notDeviceBound':
		'Keys that sync (passkeys) cannot be used. Use a USB or NFC security key.',
	'sk.error.inUse': 'This key is already registered.',
	'sk.error.minimum': 'The last key cannot be removed. Add another key first.',
	'sk.error.lastResort':
		'You are the only administrator, so this way of recovery is not available. Use the procedure for the environment’s owner.',
	'sk.error.noEmail':
		'Recovery cannot be requested because email cannot be sent. Set up email delivery.',
	'sk.error.pending': 'A recovery request is already open.',
	'sk.error.waiting': 'It cannot be completed yet. Please try again after {date}.',
	'sk.error.cancelled': 'The confirmation was cancelled.',
	'sk.error.windowClosed':
		'The window for registering a first key has closed. File a recovery request instead.',
	'sk.addTotp': 'Add authenticator app',
	'sk.totp.title': 'Add an authenticator app as a second factor',
	'sk.totp.body':
		'Scan the QR code with your authenticator app, then type the 6-digit code it shows.',
	'sk.totp.qrAlt': 'QR code for your authenticator app',
	'sk.totp.secret': 'If you cannot scan the QR code',
	'sk.totp.secretHint':
		'Type this key into your authenticator app. It is shown only now and never again.',
	'sk.totp.code': 'Code from your authenticator app',
	'sk.totp.confirm': 'Add',
	'sk.totp.added': 'Authenticator app added as a second factor.',
	'sk.totp.badge': 'Authenticator app',
	'sk.totp.weaker':
		'An authenticator app code is a weaker factor than a security key: a person can be tricked into typing it.',
	'sk.error.totpNotAllowed': 'This tenant does not allow authenticator apps as a second factor.',
	'sk.error.totpInUse': 'An authenticator app is already registered. Remove it first.',
	'sk.error.totpInvalid':
		'The code was not accepted. Type the current code from your authenticator app.',
	'sk.error.rateLimited': 'Too many attempts. Wait a few minutes and try again.',
	'sk.error.totpExpired': 'Time ran out. Start again.',
	'sk.others.title': 'Recovery requests of other administrators',
	'sk.others.info':
		'Administrators of this tenant asked to replace their security keys. Cancel any request you do not expect.',
	'sk.others.admin': 'Administrator',
	'sk.others.kind': 'New factor',
	'sk.others.requested': 'Requested',
	'sk.others.notBefore': 'Can be completed after',
	'sk.others.cancel': 'Cancel',
	'sk.others.cancelTitle': 'Cancel the request of {email}?',
	'sk.others.cancelBody':
		'The key registered for it will not be added. The administrator and the tenant’s administrators are emailed.',
	'sk.others.cancelled': 'The request was cancelled.',
	'sk.others.noPermission': 'You are not allowed to do this.',
	'sk.others.loadFailed': 'Recovery requests could not be loaded.'
};
