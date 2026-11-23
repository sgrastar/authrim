import type { jaIpAllowlist } from './ja';

export const deIpAllowlist: Record<keyof typeof jaIpAllowlist, string> = {
	'ip.page.desc':
		'Beschränkt die IP-Adressen, die die Admin-Konsole und die Admin-API erreichen. Die Einstellung gilt für die Administratoren dieses Tenants und betrifft die Anmeldung von Endnutzern nicht.',
	'ip.add': 'IP hinzufügen',
	'ip.check': 'IP prüfen',

	'ip.status.open.title': 'Keine IP-Beschränkung eingestellt',
	'ip.status.open.body':
		'Administratoren können sich von jeder IP-Adresse aus anmelden. Sobald Sie einen aktiven Eintrag hinzufügen, geht das nur noch von Adressen in dessen Bereich.',
	'ip.status.active.title': 'Die IP-Beschränkung ist aktiv',
	'ip.status.active.body':
		'Nur Adressen im Bereich eines aktiven Eintrags erreichen die Admin-Konsole und die Admin-API.',
	'ip.you.label': 'Ihre IP-Adresse',
	'ip.you.allowed': 'Zugelassen',
	'ip.you.blocked': 'Nicht zugelassen',
	'ip.you.unknown': 'Nicht feststellbar',
	'ip.you.none': 'Ihre IP-Adresse konnte nicht gelesen werden.',
	'ip.you.ipv6':
		'Das ist eine IPv6-Adresse. Ein IPv4-Bereich lässt sie nicht zu, und auf dieser Seite lassen sich nur IPv4-Bereiche hinzufügen.',

	'ip.list.title': 'Eingetragene IP-Adressen',
	'ip.col.range': 'IP-Adresse oder Bereich',
	'ip.col.size': 'Umfang',
	'ip.col.status': 'Status',
	'ip.col.created': 'Hinzugefügt',
	'ip.col.actions': 'Aktionen',
	'ip.col.actionsFor': 'Aktionen für {range}',
	'ip.size.single': 'Eine Adresse',
	'ip.size.range': '{count} Adressen',
	'ip.size.ipv6': 'IPv6',
	'ip.on': 'Aktiv',
	'ip.off': 'Aus',
	'ip.mine': 'Enthält Ihre IP',
	'ip.empty.title': 'Noch nichts eingetragen',
	'ip.empty.body':
		'Fügen Sie eine IP-Adresse oder einen Bereich hinzu, um die IP-Beschränkung einzuschalten.',
	'ip.noAccess': 'Sie haben keinen Zugriff auf die IP-Beschränkung.',
	'ip.loadFailed': 'Die IP-Beschränkung konnte nicht geladen werden.',

	'ip.action.edit': 'Bearbeiten',
	'ip.action.enable': 'Einschalten',
	'ip.action.disable': 'Ausschalten',
	'ip.action.delete': 'Löschen',

	'ip.new.title': 'IP hinzufügen',
	'ip.new.submit': 'Hinzufügen',
	'ip.edit.title': 'IP bearbeiten',
	'ip.edit.submit': 'Speichern',
	'ip.field.range': 'IP-Adresse oder Bereich',
	'ip.field.rangeHint':
		'Geben Sie eine IPv4-Adresse (203.0.113.5) oder einen Bereich in CIDR-Schreibweise (203.0.113.0/24) ein.',
	'ip.field.rangeIpv6':
		'Ein IPv6-Eintrag lässt sich auf dieser Seite nicht ändern. Sie können seine Beschreibung ändern, ihn ausschalten oder löschen.',
	'ip.field.description': 'Beschreibung (optional)',
	'ip.field.descriptionPlaceholder': 'Zum Beispiel: Netzwerk der Zentrale',
	'ip.useMine': 'Meine IP verwenden',
	'ip.preview.single': 'Diese eine Adresse ist abgedeckt.',
	'ip.preview.range': '{first} bis {last} ({count} Adressen) sind abgedeckt.',
	'ip.preview.all': 'Jede IPv4-Adresse ist abgedeckt.',
	'ip.preview.normalized': 'Gespeichert wird {range}.',
	'ip.preview.mine': 'Ihre IP-Adresse ist enthalten.',
	'ip.preview.notMine': 'Ihre IP-Adresse ist nicht enthalten.',

	'ip.err.empty': 'Geben Sie eine IP-Adresse oder einen Bereich ein.',
	'ip.err.address':
		'Das ist keine IPv4-Adresse. Geben Sie vier Zahlen von 0 bis 255 ein, durch Punkte getrennt.',
	'ip.err.prefix': 'Die Länge des Bereichs liegt zwischen 0 und 32 (zum Beispiel /24).',
	'ip.err.ipv6':
		'IPv6 lässt sich auf dieser Seite nicht hinzufügen. Geben Sie eine IPv4-Adresse ein.',
	'ip.err.duplicate': 'Dieser Bereich ist bereits eingetragen.',
	'ip.err.invalid': 'Der Server hat diesen Wert nicht akzeptiert. Prüfen Sie Ihre Eingabe.',
	'ip.err.forbidden': 'Sie dürfen das nicht tun.',
	'ip.err.notFound': 'Dieser Eintrag wurde bereits gelöscht. Die Liste wird neu geladen.',
	'ip.err.generic': 'Speichern nicht möglich. Versuchen Sie es erneut.',

	'ip.lock.title': 'Sie würden sich aussperren',
	'ip.lock.body':
		'Nach dieser Änderung liegt Ihre IP-Adresse ({ip}) in keinem zugelassenen Bereich. Nach dem Speichern erreichen Sie die Admin-Konsole von dieser Adresse aus nicht mehr.',
	'ip.lock.bodyNoIp':
		'Nach dieser Änderung liegt Ihre IP-Adresse möglicherweise in keinem zugelassenen Bereich. Nach dem Speichern erreichen Sie die Admin-Konsole eventuell nicht mehr.',
	'ip.lock.ipv6': 'Eine IPv6-Adresse kann durch einen IPv4-Bereich nicht zugelassen werden.',
	'ip.lock.confirm': 'Trotzdem fortfahren',

	'ip.delete.title': '{range} löschen?',
	'ip.delete.body': 'Der Eintrag wird gelöscht. Das lässt sich nicht rückgängig machen.',
	'ip.delete.last':
		'Es bleibt kein aktiver Eintrag übrig, die IP-Beschränkung wird aufgehoben und jede IP-Adresse kann sich anmelden.',
	'ip.delete.confirm': 'Löschen',

	'ip.check.title': 'IP prüfen',
	'ip.check.desc':
		'Prüfen Sie, ob eine IP-Adresse mit den aktiven Einträgen die Admin-Konsole erreichen könnte.',
	'ip.check.field': 'IP-Adresse',
	'ip.check.submit': 'Prüfen',
	'ip.check.allowed': '{ip} ist zugelassen.',
	'ip.check.blocked': '{ip} ist nicht zugelassen.',
	'ip.check.open':
		'Es ist keine IP-Beschränkung eingestellt, daher ist jede IP-Adresse zugelassen.',
	'ip.check.invalid': 'Geben Sie eine IPv4-Adresse ein.',

	'ip.toast.added': 'IP hinzugefügt.',
	'ip.toast.saved': 'Änderungen gespeichert.',
	'ip.toast.enabled': 'Eingeschaltet.',
	'ip.toast.disabled': 'Ausgeschaltet.',
	'ip.toast.deleted': 'Gelöscht.'
};
