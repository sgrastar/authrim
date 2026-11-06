/**
 * Keyring as a step-up second factor: the presentation dialog and its enrolment. Spread into
 * `../de.ts`.
 */
export const deKeyringPresentation = {
	'kp.starting': 'Anfrage wird vorbereitet…',
	'kp.scan': 'Scannen Sie den QR-Code mit Authrim Keyring.',
	'kp.step.scan': 'Scannen Sie den QR-Code mit Authrim Keyring auf Ihrem iPhone.',
	'kp.step.code':
		'Prüfen Sie, was Sie bestätigen, und geben Sie die hier gezeigte Zahl in Keyring ein.',
	'kp.step.confirm': 'Bestätigen Sie mit Face ID oder Ihrem Code.',
	'kp.qr.alt': 'QR-Code für Authrim Keyring',
	'kp.code.label': 'In Keyring einzugebende Zahl',
	'kp.code.note':
		'Die Zahl steht nicht im QR-Code. Geben Sie nie eine Zahl ein, die Ihnen jemand anderes nennt.',
	'kp.checking': 'Keyring hat geantwortet. Wird geprüft…',
	'kp.expiresIn': 'Noch {time} gültig',
	'kp.verified': 'Mit Keyring bestätigt.',
	'kp.expired': 'Die Zeit ist abgelaufen. Beginnen Sie erneut.',
	'kp.failed': 'Keyring konnte nicht bestätigt werden. Beginnen Sie erneut.',
	'kp.failed.matchCode':
		'Die in Keyring eingegebene Zahl stimmte nicht. Diese Anfrage ist nicht mehr gültig: Beginnen Sie erneut.',
	'kp.failed.notRegistered': 'Dieser Keyring-Nachweis ist nicht als zweiter Faktor registriert.',
	'kp.failed.alreadyRegistered':
		'Dieser Keyring-Nachweis ist bereits oder war schon einmal registriert.',
	'kp.failed.notActive': 'Dieser Keyring-Nachweis ist gesperrt oder widerrufen.',
	'kp.failed.wrongAdmin': 'Dieser Keyring-Nachweis gehört einem anderen Administrator.',
	'kp.failed.stale':
		'Die zugrunde liegende Bestätigung ist nicht mehr aktuell. Beginnen Sie den Vorgang erneut.',
	'kp.error': 'Die Anfrage konnte nicht gestartet werden.',
	'kp.error.cancelled': 'Die Bestätigung wurde abgebrochen.',
	'kp.error.notRegistered': 'Noch kein Keyring-Nachweis ist als zweiter Faktor registriert.',
	'kp.error.notEligible': 'Sie können den Administrator-Nachweis derzeit nicht verwenden.',
	'kp.error.unavailable': 'Keyring ist in dieser Umgebung nicht verfügbar.',
	'kp.error.recovery':
		'Kein zweiter Faktor ist registriert und die Frist für die erste Registrierung ist abgelaufen: Beantragen Sie eine Wiederherstellung.',
	'kp.again': 'Erneut beginnen',
	'kp.prompt.title': 'Mit dem zweiten Faktor bestätigen',
	'kp.prompt.desc': 'Für diesen Vorgang ist neben Ihrem Passkey eine zweite Bestätigung nötig.',
	'kp.prompt.keyringDesc': 'Legen Sie Ihren Administrator-Nachweis aus Authrim Keyring vor.',
	'kp.prompt.choose': 'Wie möchten Sie bestätigen?',
	'kp.prompt.keyring': 'Authrim Keyring',
	'kp.prompt.keyringHint':
		'Scannen Sie mit Ihrem iPhone einen QR-Code und geben Sie eine Zahl ein.',
	'kp.prompt.securityKey': 'Sicherheitsschlüssel',
	'kp.prompt.securityKeyHint':
		'Verwenden Sie einen registrierten USB- oder NFC-Sicherheitsschlüssel.',
	'kp.prompt.continue': 'Weiter',
	'kp.prompt.other': 'Sicherheitsschlüssel verwenden',
	'kp.enroll.add': 'Keyring hinzufügen',
	'kp.enroll.title': 'Authrim Keyring als zweiten Faktor hinzufügen',
	'kp.enroll.body':
		'Legen Sie den in Keyring ausgestellten Administrator-Nachweis vor. Sein Schlüssel wird einer Ihrer zweiten Faktoren.',
	'kp.enroll.needCredential':
		'Stellen Sie zuerst den Administrator-Nachweis in Keyring aus (Mein Konto → Authrim Keyring).',
	'kp.enroll.added': 'Keyring wurde als zweiter Faktor hinzugefügt.',
	'kp.kind.keyring': 'Keyring',
	'kp.kind.securityKey': 'Sicherheitsschlüssel'
};
