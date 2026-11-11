import type { jaSessionProfiles } from './ja';

export const deSessionProfiles: { [K in keyof typeof jaSessionProfiles]: string } = {
	'sp.list.title': 'Sitzungsprofile',
	'sp.list.description':
		'Fassen Sie zusammen, wie lange eine Sitzung dauert, ob sie verlängert werden kann und Single Sign-on, und wählen Sie in jedem Service-Flow ein Profil.',
	'sp.list.create': 'Profil erstellen',
	'sp.list.name': 'Profilname',
	'sp.list.summary': 'Sitzungsdauer · Single Sign-on',
	'sp.list.asDefault': 'Dieselbe Dauer wie Default',
	'sp.list.ssoOn': 'Single Sign-on: an',
	'sp.list.ssoOff': 'Single Sign-on: aus',
	'sp.list.created': 'Erstellt',
	'sp.list.updated': 'Aktualisiert',
	'sp.list.empty': 'Noch keine Profile',
	'sp.list.actions': 'Aktionen für {name}',
	'sp.list.open': '{name} öffnen',
	'sp.list.delete': 'Löschen',
	'sp.list.deleteTitle': '„{name}“ löschen?',
	'sp.list.deleteBody':
		'Dieses Profil kann nicht wiederhergestellt werden. Solange ein Service-Flow es verwendet, kann es nicht gelöscht werden.',
	'sp.list.deleteSuccess': 'Profil gelöscht.',
	'sp.page.new': 'Neues Profil',
	'sp.page.back': 'Sitzungsprofile',
	'sp.page.name': 'Profilname',
	'sp.page.nameHint': 'Ein Name, an dem Sie dieses Profil in Listen erkennen (bis zu 80 Zeichen).',
	'sp.page.nameRequired': 'Geben Sie einen Profilnamen ein.',
	'sp.page.nameTaken': 'Ein Profil mit diesem Namen gibt es bereits.',
	'sp.page.editName': 'Profilnamen bearbeiten',
	'sp.page.nameDone': 'Fertig',
	'sp.page.description':
		'Legt fest, wie lange eine Sitzung dauert, die ein Service-Flow mit diesem Profil erstellt, ob sie verlängert werden kann, und Single Sign-on. Default sind die Sitzungseinstellungen des Mandanten selbst.',
	'sp.page.saved': 'Profil gespeichert.',
	'sp.page.loadFailed': 'Das Profil konnte nicht geladen werden.',
	'sp.page.notFound': 'Profil nicht gefunden.',
	'sp.page.saveFailed': 'Das Profil konnte nicht gespeichert werden.',
	'sp.page.conflict':
		'Eine andere Änderung wurde gespeichert. Laden Sie neu und versuchen Sie es erneut.',
	'sp.page.noAccess': 'Sie können dieses Profil nicht ansehen.',
	'sp.fields.length': 'Sitzungsdauer',
	'sp.fields.lengthDesc':
		'Wie lange es dauert, bis sich eine angemeldete Person erneut anmelden muss.',
	'sp.fields.perMethod': 'Dauer nach Verfahren',
	'sp.fields.perMethodDesc':
		'Legen Sie diese fest, um die Dauer nach dem Anmeldeverfahren zu unterscheiden. Keine überschreitet die längste Dauer.',
	'sp.fields.behaviour': 'Verlängerung und Single Sign-on',
	'sp.field.label': 'Sitzungsprofil',
	'sp.field.hint': 'Wie lange eine Sitzung dieses Flows dauert, und Single Sign-on.',
	'sp.field.open': 'Profil öffnen',
	'sp.field.manage': 'Alle Sitzungsprofile',
	'sp.field.loadFailed': 'Die Sitzungsprofile konnten nicht geladen werden.',
	'sp.field.missing': 'Das hier gewählte Profil gibt es nicht mehr. Wählen Sie ein anderes.',
	'sp.fields.asDefault': 'Wie Default',
	'sp.fields.emptyAsDefault': 'Leer lassen, um dem Default-Profil zu folgen.',
	'sp.fields.required': 'Im Default-Profil darf dies nicht leer sein.',
	'sp.list.ssoAsDefault': 'Single Sign-on: wie Default'
};
