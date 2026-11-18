import type { jaOnboarding } from './ja';

export const deOnboarding: Record<keyof typeof jaOnboarding, string> = {
	'ob.title': 'Erste Schritte',
	'ob.lead':
		'Ein paar Dinge zum Ausprobieren in einer neuen Umgebung. Eine Anleitung führt zur passenden Seite und zeigt Schritt für Schritt, wo etwas zu tun ist.',
	'ob.progress': '{done} von {total} erledigt',
	'ob.progressLabel': 'Fortschritt der ersten Schritte',
	'ob.allDone': 'Alles erledigt. Jede Anleitung lässt sich erneut ansehen.',
	'ob.loadFailed': 'Der Fortschritt konnte nicht geladen werden.',
	'ob.saveFailed': 'Der Fortschritt konnte nicht gespeichert werden.',
	'ob.status.done': 'Erledigt',
	'ob.status.todo': 'Offen',
	'ob.status.active': 'Anleitung läuft',
	'ob.start': 'Anleitung starten',
	'ob.startNamed': 'Anleitung starten: {name}',
	'ob.again': 'Erneut ansehen',
	'ob.againNamed': 'Erneut ansehen: {name}',
	'ob.stop': 'Anleitung beenden',
	'ob.stopNamed': 'Anleitung beenden: {name}',
	'ob.markDone': 'Als erledigt markieren',
	'ob.markDoneNamed': 'Als erledigt markieren: {name}',
	'ob.markTodo': 'Als offen markieren',
	'ob.markTodoNamed': 'Als offen markieren: {name}',
	'ob.next': 'Weiter',
	'ob.back': 'Zurück',
	'ob.close': 'Anleitung schließen',
	'ob.stepOf': '{current} von {total}',
	'ob.done.title': 'Erledigt',
	'ob.done.body': '„{name}“ ist jetzt abgehakt.',
	'ob.done.back': 'Zurück zur Liste',

	'ob.signIn.title': 'Zuerst einmal anmelden',
	'ob.signIn.desc': 'Die Anmeldeseite dieses Mandanten öffnen und mit einem Passkey anmelden.',
	'ob.signIn.s1.title': 'Anmeldeseite dieses Mandanten',
	'ob.signIn.s1.body':
		'Unter dieser Adresse melden sich Benutzer an. In einem neuen Tab öffnen, ein Konto registrieren und mit einem Passkey anmelden.',
	'ob.signIn.s1.action': 'Die Adresse in dieser Zeile öffnen.',

	'ob.theme.title': 'Die Anmeldeseite anpassen',
	'ob.theme.desc': 'Mit einem Design Hintergrundbild und Textfarben der Anmeldeseite ändern.',
	'ob.theme.s1.title': 'Ein Design öffnen',
	'ob.theme.s1.body': 'Das Aussehen der Anmeldeseite wird als Design gespeichert.',
	'ob.theme.s1.action': 'Ein Design erstellen oder eines aus der Liste öffnen.',
	'ob.theme.s2.title': 'Layout',
	'ob.theme.s2.body': 'Hier wird das Layout der Seite festgelegt.',
	'ob.theme.s3.title': 'Design',
	'ob.theme.s3.body': 'Hier werden Farben, etwa die Textfarbe, und die Schrift geändert.',
	'ob.theme.s4.title': 'Bilder',
	'ob.theme.s4.body': 'Hier werden Hintergrundbild und Logo geändert.',
	'ob.theme.s4.action': 'Diesen Tab öffnen.',
	'ob.theme.s5.title': 'Ein Hintergrundbild wählen',
	'ob.theme.s5.body': 'Zum Ausprobieren ein Hintergrundbild aus den Vorlagen wählen.',
	'ob.theme.s5.action': 'Mit dieser Schaltfläche die Vorlagen öffnen und ein Bild wählen.',
	'ob.theme.s5.fallback':
		'Das Hintergrundbild wird im Tab für den hellen Modus festgelegt. Diesen Tab öffnen.',
	'ob.theme.s6.title': 'Das Bild ist gewählt',
	'ob.theme.s6.body': 'Jetzt nach Belieben weiter ändern. Die Vorschau zeigt Änderungen sofort.',
	'ob.theme.s6.action': 'Zum Abschluss auf Speichern drücken. Die Anleitung endet dort.',

	'ob.schema.title': 'Das Schema erweitern oder ändern',
	'ob.schema.desc': 'Attribute, die zu jedem Benutzer gespeichert werden, hinzufügen oder ändern.',
	'ob.schema.s1.title': 'Ein Attribut hinzufügen',
	'ob.schema.s1.body':
		'Ein Attribut ist etwas, das zu jedem Benutzer gespeichert wird. Hier wird ein neues hinzugefügt. Die Schaltfläche daneben fügt mehrere aus einer Vorlage hinzu; ein Attribut aus der Liste lässt sich öffnen und ändern.',
	'ob.schema.s1.action': 'Ein Attribut hinzufügen oder eines ändern und speichern.',

	'ob.screens.title': 'Registrierungs- und Anmeldeseite anpassen',
	'ob.screens.desc':
		'Eingabeelemente auf einem Bildschirm platzieren und die Eingaben in Attributen speichern.',
	'ob.screens.s1.title': 'Einen Bildschirm öffnen',
	'ob.screens.s1.body':
		'Welche Elemente auf Registrierungs- und Anmeldeseite stehen, wird in einem Bildschirm festgelegt.',
	'ob.screens.s1.action': 'Einen Bildschirm erstellen oder einen aus der Liste öffnen.',
	'ob.screens.s2.title': 'Einen Bildschirm erstellen',
	'ob.screens.s2.body':
		'Nach der Wahl einer Vorlage folgt die Seite, auf der Elemente angeordnet werden.',
	'ob.screens.s2.action': 'Eine Vorlage wählen und den Bildschirm erstellen.',
	'ob.screens.s3.title': 'Eingabeelemente',
	'ob.screens.s3.body':
		'Diese Elemente speichern die Eingabe eines Benutzers in einem Attribut des Schemas. Auch das eben hinzugefügte Attribut steht zur Wahl.',
	'ob.screens.s3.action': 'Ein Element anklicken, um es zum Bildschirm hinzuzufügen.',
	'ob.screens.s4.title': 'Wo der Wert gespeichert wird',
	'ob.screens.s4.body':
		'Die Einstellungen des hinzugefügten Elements. Hier wird das Attribut gewählt, in dem die Eingabe gespeichert wird.',
	'ob.screens.s5.title': 'Speichern',
	'ob.screens.s5.body': 'Anordnung und Einstellungen der Elemente nach Belieben ändern.',
	'ob.screens.s5.action': 'Zum Abschluss auf Speichern drücken. Die Anleitung endet dort.'
};
