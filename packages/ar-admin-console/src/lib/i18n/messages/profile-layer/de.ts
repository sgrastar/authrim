import type { jaProfileLayer } from './ja';

export const deProfileLayer: { [K in keyof typeof jaProfileLayer]: string } = {
	'pl.platform': 'Plattform',
	'pl.overridden': 'Überschrieben',
	'pl.inactive': 'Überschreibung ausgesetzt',
	'pl.locked': 'Gesperrt',
	'pl.updated': 'Plattform aktualisiert',
	'pl.copyNote':
		'Dieses Profil gehört der Plattform. Beim Speichern entsteht eine Kopie für diesen Mandanten; die Werte der Plattform bleiben unverändert.',
	'pl.copyActive':
		'Dieser Mandant verwendet seine eigene Kopie. Die Rückkehr zu den Werten der Plattform entfernt die Kopie.',
	'pl.defaultNote':
		'Unter Default liegen die Werte der Plattform: Eine Einstellung, die dieser Mandant nicht setzt, übernimmt den Wert der Plattform. Beim Speichern werden die angezeigten Werte als eigene Kopie des Mandanten gespeichert.',
	'pl.readOnlyLocked':
		'Die Plattform hat dies gesperrt; es kann hier nicht geändert werden. Angezeigt werden die Werte der Plattform.',
	'pl.readOnlyNotAllowed':
		'Die Plattform erlaubt Mandanten nicht, dies zu ändern; es kann hier nicht geändert werden. Angezeigt werden die Werte der Plattform.',
	'pl.readOnly': 'Dieses Profil kann gerade nicht geändert werden.',
	'pl.copyKept':
		'Die Kopie dieses Mandanten bleibt erhalten und gilt wieder, sobald die Plattform es erlaubt.',
	'pl.updatedNote':
		'Die Plattform hat dies geändert, seit die Kopie dieses Mandanten erstellt wurde. Um die neuen Werte zu übernehmen, kehren Sie zu den Werten der Plattform zurück.',
	'pl.revert': 'Werte der Plattform verwenden',
	'pl.revertTitle': 'Für {name} die Werte der Plattform verwenden?',
	'pl.revertBody':
		'Die für diesen Mandanten geänderten Werte werden entfernt und die Werte der Plattform gelten.',
	'pl.revertSuccess': 'Es gelten jetzt die Werte der Plattform',
	'pl.revertFailed': 'Die Werte der Plattform konnten nicht wiederhergestellt werden',
	'pl.notEditable': 'Die Plattform erlaubt diese Änderung nicht; sie wurde nicht gespeichert',
	'pl.creationNotAllowed': 'Die Plattform erlaubt Mandanten nicht, eigene Profile hinzuzufügen.',
	'pl.optionPlatform': '{name} (Plattform)'
};
