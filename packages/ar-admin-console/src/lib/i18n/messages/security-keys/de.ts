import type { jaSecurityKeys } from './ja';

export const deSecurityKeys: Record<keyof typeof jaSecurityKeys, string> = {
	'sk.title': 'Sicherheitsschlüssel',
	'sk.info':
		'Schlüssel, die vor kritischen Vorgängen zusätzlich zu Ihrem Passkey bestätigt werden. Nur nicht synchronisierte Schlüssel (USB- oder NFC-Sicherheitsschlüssel) können registriert werden. Sie dienen nicht der Anmeldung.',
	'sk.add': 'Sicherheitsschlüssel hinzufügen',
	'sk.addTitle': 'Sicherheitsschlüssel hinzufügen',
	'sk.addBody': 'Geben Sie ihm einen Namen, damit Sie ihn später erkennen.',
	'sk.name': 'Name',
	'sk.nameHint': 'Zum Beispiel: YubiKey (blau)',
	'sk.register': 'Schlüssel registrieren',
	'sk.unnamed': 'Ohne Namen',
	'sk.only': 'Einziger Schlüssel',
	'sk.created': 'Registriert',
	'sk.lastUsed': 'Zuletzt verwendet',
	'sk.never': 'Nie',
	'sk.revoked': 'Widerrufen',
	'sk.remove': 'Entfernen',
	'sk.removeTitle': '„{name}“ entfernen?',
	'sk.removeBody': 'Mit diesem Schlüssel können keine Vorgänge mehr bestätigt werden.',
	'sk.added': 'Der Sicherheitsschlüssel wurde hinzugefügt.',
	'sk.removed': 'Der Sicherheitsschlüssel wurde entfernt.',
	'sk.loadFailed': 'Die Sicherheitsschlüssel konnten nicht geladen werden.',
	'sk.empty': 'Keine Sicherheitsschlüssel',
	'sk.first.title': 'Registrieren Sie Ihren ersten Schlüssel bis {date}',
	'sk.first.body':
		'Bis dahin genügt die Bestätigung mit Ihrem Passkey, um den ersten Schlüssel zu registrieren.',
	'sk.recoveryNeeded.title': 'Für einen Schlüssel ist ein Wiederherstellungsantrag nötig',
	'sk.recoveryNeeded.body':
		'Der Zeitraum für den ersten Schlüssel ist abgelaufen. Beantragen Sie die Wiederherstellung mit einem neuen Schlüssel; sie kann nach 24 Stunden abgeschlossen werden.',
	'sk.recover': 'Wiederherstellung beantragen',
	'sk.recoverTitle': 'Wiederherstellung der Schlüssel beantragen',
	'sk.recoverBody':
		'Registrieren Sie einen neuen Schlüssel für den Antrag. Sie und alle Administratoren des Mandanten erhalten eine E-Mail; nach 24 Stunden kann er abgeschlossen werden. Beim Abschluss werden alle aktuellen Schlüssel widerrufen und Ihre anderen Sitzungen beendet.',
	'sk.recoverSubmit': 'Schlüssel registrieren und beantragen',
	'sk.recoveryFiled': 'Die Wiederherstellung wurde beantragt.',
	'sk.recovery.waiting.title': 'Wiederherstellung beantragt',
	'sk.recovery.waiting.body':
		'Sie kann nach {date} abgeschlossen werden. Bis dahin können Sie oder ein anderer Administrator den Antrag zurückziehen.',
	'sk.recovery.ready.title': 'Die Wiederherstellung kann abgeschlossen werden',
	'sk.recovery.ready.body':
		'Beim Abschluss werden alle aktuellen Schlüssel widerrufen und Ihre anderen Sitzungen beendet.',
	'sk.recovery.complete': 'Wiederherstellung abschließen',
	'sk.recovery.completeTitle': 'Wiederherstellung abschließen?',
	'sk.recovery.completed': 'Die Wiederherstellung wurde abgeschlossen.',
	'sk.recovery.cancel': 'Antrag zurückziehen',
	'sk.recovery.cancelTitle': 'Wiederherstellungsantrag zurückziehen?',
	'sk.recovery.cancelBody': 'Der dafür registrierte Schlüssel wird nicht hinzugefügt.',
	'sk.recovery.cancelled': 'Der Wiederherstellungsantrag wurde zurückgezogen.',
	'sk.error':
		'Der Sicherheitsschlüssel konnte nicht geändert werden. Bitte versuchen Sie es erneut.',
	'sk.error.notDeviceBound':
		'Synchronisierte Schlüssel (Passkeys) können nicht verwendet werden. Verwenden Sie einen USB- oder NFC-Sicherheitsschlüssel.',
	'sk.error.inUse': 'Dieser Schlüssel ist bereits registriert.',
	'sk.error.minimum':
		'Der letzte Schlüssel kann nicht entfernt werden. Fügen Sie zuerst einen anderen hinzu.',
	'sk.error.lastResort':
		'Sie sind der einzige Administrator, daher ist diese Wiederherstellung nicht möglich. Verwenden Sie das Verfahren für den Betreiber der Umgebung.',
	'sk.error.noEmail':
		'Die Wiederherstellung kann nicht beantragt werden, weil keine E-Mail gesendet werden kann. Richten Sie den E-Mail-Versand ein.',
	'sk.error.pending': 'Es gibt bereits einen offenen Wiederherstellungsantrag.',
	'sk.error.waiting': 'Noch nicht möglich. Bitte versuchen Sie es nach {date} erneut.',
	'sk.error.cancelled': 'Die Bestätigung wurde abgebrochen.',
	'sk.error.windowClosed':
		'Die Frist für den ersten Schlüssel ist abgelaufen. Stellen Sie stattdessen einen Wiederherstellungsantrag.',
	'sk.others.title': 'Wiederherstellungsanträge anderer Administratoren',
	'sk.others.info':
		'Administratoren dieses Mandanten möchten ihre Sicherheitsschlüssel ersetzen. Ziehen Sie unerwartete Anträge zurück.',
	'sk.others.admin': 'Administrator',
	'sk.others.requested': 'Beantragt',
	'sk.others.notBefore': 'Abschluss möglich ab',
	'sk.others.cancel': 'Zurückziehen',
	'sk.others.cancelTitle': 'Antrag von {email} zurückziehen?',
	'sk.others.cancelBody':
		'Der dafür registrierte Schlüssel wird nicht hinzugefügt. Der Administrator und die Administratoren des Mandanten erhalten eine E-Mail.',
	'sk.others.cancelled': 'Der Antrag wurde zurückgezogen.',
	'sk.others.noPermission': 'Dazu sind Sie nicht berechtigt.',
	'sk.others.loadFailed': 'Die Wiederherstellungsanträge konnten nicht geladen werden.'
};
