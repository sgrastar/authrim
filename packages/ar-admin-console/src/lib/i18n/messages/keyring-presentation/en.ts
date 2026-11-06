/**
 * Keyring as a step-up second factor: the presentation dialog and its enrolment. Spread into
 * `../en.ts`.
 */
export const enKeyringPresentation = {
	'kp.starting': 'Preparing the request…',
	'kp.scan': 'Scan the QR code with Authrim Keyring.',
	'kp.step.scan': 'Scan the QR code with Authrim Keyring on your iPhone.',
	'kp.step.code': 'Check what you are approving, then type the number shown here into Keyring.',
	'kp.step.confirm': 'Confirm with Face ID or your passcode.',
	'kp.qr.alt': 'QR code for Authrim Keyring',
	'kp.code.label': 'Number to type into Keyring',
	'kp.code.note': 'The number is not in the QR code. Never type a number someone else gives you.',
	'kp.checking': 'Keyring answered. Checking…',
	'kp.expiresIn': 'Valid for {time}',
	'kp.verified': 'Confirmed with Keyring.',
	'kp.expired': 'The time ran out. Start again.',
	'kp.failed': 'Keyring could not be confirmed. Start again.',
	'kp.failed.matchCode':
		'The number typed into Keyring did not match. This request can no longer be used: start again.',
	'kp.failed.notRegistered':
		'This Keyring credential is not registered as one of your second factors.',
	'kp.failed.alreadyRegistered':
		'This Keyring credential is already registered, or was registered before.',
	'kp.failed.notActive': 'This Keyring credential is suspended or revoked.',
	'kp.failed.wrongAdmin': 'This Keyring credential belongs to another administrator.',
	'kp.failed.stale':
		'The confirmation this rests on is no longer fresh. Start the operation again.',
	'kp.error': 'The request could not be started.',
	'kp.error.cancelled': 'The confirmation was cancelled.',
	'kp.error.notRegistered': 'No Keyring credential is registered as a second factor yet.',
	'kp.error.notEligible': 'You cannot use the admin credential at the moment.',
	'kp.error.unavailable': 'Keyring is not available in this environment.',
	'kp.error.recovery':
		'No second factor is registered and the first-registration period has ended: request a recovery.',
	'kp.again': 'Start again',
	'kp.prompt.title': 'Confirm with your second factor',
	'kp.prompt.desc': 'This operation needs a second confirmation besides your passkey.',
	'kp.prompt.keyringDesc': 'Present your admin credential from Authrim Keyring.',
	'kp.prompt.choose': 'How do you want to confirm?',
	'kp.prompt.keyring': 'Authrim Keyring',
	'kp.prompt.keyringHint': 'Scan a QR code with your iPhone and type a number.',
	'kp.prompt.securityKey': 'Security key',
	'kp.prompt.securityKeyHint': 'Use a registered USB or NFC security key.',
	'kp.prompt.continue': 'Continue',
	'kp.prompt.other': 'Use a security key',
	'kp.enroll.add': 'Add Keyring',
	'kp.enroll.title': 'Add Authrim Keyring as a second factor',
	'kp.enroll.body':
		'Present the admin credential issued to your Keyring. Its key becomes one of your second factors.',
	'kp.enroll.needCredential':
		'First issue the admin credential to Keyring (My account → Authrim Keyring).',
	'kp.enroll.added': 'Keyring was added as a second factor.',
	'kp.kind.keyring': 'Keyring',
	'kp.kind.securityKey': 'Security key'
};
