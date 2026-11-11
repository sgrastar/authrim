import type { jaPlatformProfiles } from './ja';

export const dePlatformProfiles: { [K in keyof typeof jaPlatformProfiles]: string } = {
	'pp.title.method': 'Methodenprofile der Plattform',
	'pp.title.session': 'Sitzungsprofile der Plattform',
	'pp.desc.method':
		'Anmeldemethodenprofile, die jeder Mandant verwenden kann, und das Default der Plattform unter dem Default jedes Mandanten.',
	'pp.desc.session':
		'Sitzungsprofile, die jeder Mandant verwenden kann, und das Default der Plattform unter dem Default jedes Mandanten.',
	'pp.tab.profiles': 'Profile',
	'pp.tab.default': 'Default und Berechtigungen',
	'pp.list.name': 'Profilname',
	'pp.list.overriding': 'Kopien der Mandanten',
	'pp.list.overridingCount': '{count} Mandanten',
	'pp.list.updated': 'Aktualisiert',
	'pp.list.actions': 'Aktionen für {name}',
	'pp.list.open': '{name} öffnen',
	'pp.list.create': 'Profil erstellen',
	'pp.list.empty': 'Noch keine Profile der Plattform',
	'pp.list.lock': 'Sperren',
	'pp.list.unlock': 'Entsperren',
	'pp.list.locked': 'Gesperrt. Die Kopien der Mandanten gelten nicht mehr (sie bleiben erhalten).',
	'pp.list.unlocked': 'Entsperrt. Die Kopien der Mandanten gelten wieder.',
	'pp.list.delete': 'Löschen',
	'pp.list.deleteTitle': '{name} löschen?',
	'pp.list.deleteBody':
		'Es steht dann keinem Mandanten mehr zur Verfügung. Solange ein Service-Flow eines Mandanten es verwendet, kann es nicht gelöscht werden. Auch die Kopien der Mandanten gelten nicht mehr.',
	'pp.list.deleteSuccess': 'Gelöscht',
	'pp.list.inUse':
		'Ein Service-Flow eines Mandanten verwendet es; es kann nicht gelöscht werden. Wählen Sie dort zuerst ein anderes Profil.',
	'pp.list.checkIncomplete':
		'Nicht alle Mandanten konnten geprüft werden; es wurde nicht gelöscht. Versuchen Sie es erneut.',
	'pp.list.deleting': 'Wird gelöscht',
	'pp.list.failed': 'Die Aktion ist fehlgeschlagen',
	'pp.page.new': 'Neues Profil der Plattform',
	'pp.page.back': 'Profile der Plattform',
	'pp.page.name': 'Name',
	'pp.page.nameHint': 'Mandanten sehen es ebenfalls unter diesem Namen.',
	'pp.page.nameRequired': 'Geben Sie einen Namen ein',
	'pp.page.nameTaken': 'Es gibt bereits ein Profil der Plattform mit diesem Namen',
	'pp.page.limitReached':
		'Die Plattform hat die höchstmögliche Zahl an Profilen. Löschen Sie eines, das nicht mehr verwendet wird.',
	'pp.page.saved': 'Profil gespeichert',
	'pp.page.saveFailed': 'Speichern fehlgeschlagen',
	'pp.page.conflict':
		'Jemand anderes hat es zuerst geändert. Laden Sie neu und versuchen Sie es erneut.',
	'pp.page.notFound': 'Dieses Profil wurde nicht gefunden',
	'pp.page.noAccess': 'Sie dürfen die Profile der Plattform nicht sehen',
	'pp.page.loadFailed': 'Laden fehlgeschlagen',
	'pp.page.overriding':
		'{count} Mandanten haben eine Kopie dieses Profils. Speichern ändert ihre Kopien nicht (jeder sieht „Plattform aktualisiert“).',
	'pp.page.lockedNote':
		'Gesperrt: Die Kopien der Mandanten gelten nicht, und Mandanten können es nicht ändern.',
	'pp.page.deletingNote': 'Es wird gerade gelöscht und kann nicht geändert werden.',
	'pp.default.method': 'Default-Methoden der Plattform',
	'pp.default.method.desc':
		'Gilt, wo ein Mandant nichts festlegt. Solange gesperrt oder Mandanten keine Profile ändern dürfen, gilt es anstelle der Werte des Mandanten.',
	'pp.default.session': 'Default-Sitzungsregeln der Plattform',
	'pp.switches': 'Was Mandanten dürfen',
	'pp.switches.desc':
		'Ob Mandanten die Profile der Plattform ändern, eigene hinzufügen und ihr Default ändern dürfen. Ausschalten gilt sofort für jeden Mandanten.'
};
