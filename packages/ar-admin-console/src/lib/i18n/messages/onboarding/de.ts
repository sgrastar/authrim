import type { jaOnboarding } from './ja';

export const deOnboarding: Record<keyof typeof jaOnboarding, string> = {
	'ob.title': 'Authrim 101',
	'ob.lead':
		'Einführungslektionen für den Einstieg in Authrim. Eine Anleitung führt zur passenden Seite und zeigt Schritt für Schritt, wo etwas zu tun ist.',
	'ob.progress': '{done} von {total} erledigt',
	'ob.progressLabel': 'Fortschritt in Authrim 101',
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
	'ob.signIn.s1.title': 'Hier stehen die Angaben zum Mandanten',
	'ob.signIn.s1.body':
		'Alles zu diesem Mandanten, seine Angaben und seine Einstellungen, steht in der Kategorie „Mandant“.',
	'ob.signIn.s2.title': 'Basisdaten',
	'ob.signIn.s2.body':
		'Hier findest du die Adresse der Anmeldeseite und die weiteren Angaben, die dieser Mandant veröffentlicht.',
	'ob.signIn.s3.title': 'Anmeldeseite dieses Mandanten',
	'ob.signIn.s3.body':
		'Unter dieser Adresse melden sich Benutzer an. In einem neuen Tab öffnen, ein Konto registrieren und mit einem Passkey anmelden.',
	'ob.signIn.s3.action': 'Die Adresse in dieser Zeile öffnen.',

	'ob.theme.title': 'Die Anmeldeseite anpassen',
	'ob.theme.desc': 'Mit einem Design Hintergrundbild und Textfarben der Anmeldeseite ändern.',
	'ob.theme.nav.title': 'Hier passt du die Anmeldeseite an',
	'ob.theme.nav.body':
		'Das Anpassen der Anmeldeseite, auch von Hintergrund und Logo, findest du in der Kategorie „Anpassung“.',
	'ob.theme.sub.title': 'Designs',
	'ob.theme.sub.body':
		'Das Aussehen der Anmeldeseite wird als Design gespeichert. Deine Designs stehen hier in einer Liste.',
	'ob.theme.s1.title': 'Ein Design anlegen',
	'ob.theme.s1.body': 'Lege zuerst ein Design an.',
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
	'ob.theme.name.title': 'Dem Design einen Namen geben',
	'ob.theme.name.body':
		'Der Hintergrund ist gewählt. Gib dem Design vor dem Speichern einen Namen, an dem du es in der Liste erkennst.',
	'ob.theme.name.action': 'Namen eingeben, dann „Weiter“ drücken.',
	'ob.theme.name.fallback':
		'Mit dieser Schaltfläche änderst du den Namen. Soll er bleiben, drücke einfach „Weiter“.',
	'ob.theme.s6.title': 'Speichern',
	'ob.theme.s6.body':
		'Ändere auch alles andere, wie du möchtest. Änderungen erscheinen sofort in der Vorschau.',
	'ob.theme.s6.action': 'Drücke „Speichern“, wenn du fertig bist.',
	'ob.theme.apply.title': 'Auf die Anmeldeseite anwenden',
	'ob.theme.apply.body':
		'Das Speichern allein ändert die Anmeldeseite nicht. Mit „Anwenden“ erhält die Anmeldeseite dieses Mandanten dieses Design.',
	'ob.theme.apply.action': 'Drücke „Anwenden“ und bestätige. Damit endet die Anleitung.',

	'ob.schema.title': 'Das Schema erweitern oder ändern',
	'ob.schema.desc': 'Attribute, die zu jedem Benutzer gespeichert werden, hinzufügen oder ändern.',
	'ob.schema.nav.title': 'Hier steht, was über Personen gespeichert wird',
	'ob.schema.nav.body':
		'Die Angaben, die zu jeder Person gespeichert werden (Attribute), und die Berechtigungen findest du in der Kategorie „Zugriffssteuerung“.',
	'ob.schema.sub.title': 'Attributschema',
	'ob.schema.sub.body':
		'Die Angaben, die zu jeder Person gespeichert werden (Attribute), fügst du hier hinzu und änderst sie hier.',
	'ob.schema.s1.title': 'Ein Attribut hinzufügen',
	'ob.schema.s1.body':
		'Ein Attribut ist eine Angabe, die zu jeder Person gespeichert wird. Mit dieser Schaltfläche fügst du ein neues hinzu. Öffne ein Attribut in der Liste, um es zu ändern.',
	'ob.schema.preset.title': 'Aus einer Vorlage wählen',
	'ob.schema.preset.body':
		'Häufige Angaben wie Name oder Telefonnummer lassen sich zusammen aus einer Vorlage wählen.',

	'ob.screens.title': 'Registrierungs- und Anmeldeseite anpassen',
	'ob.screens.desc':
		'Eingabeelemente auf einem Bildschirm platzieren und die Eingaben in Attributen speichern.',
	'ob.screens.nav.title': 'Auch die Felder einer Seite legst du hier fest',
	'ob.screens.nav.body':
		'Welche Felder auf den Seiten für Registrierung und Anmeldung stehen, legst du in der Kategorie „Anpassung“ fest.',
	'ob.screens.sub.title': 'Bildschirme',
	'ob.screens.sub.body':
		'Die Elemente jeder Seite und ihre Reihenfolge werden als Bildschirm gespeichert.',
	'ob.screens.row.title': 'Der Bildschirm für die Registrierung',
	'ob.screens.row.body':
		'Dieser Bildschirm legt fest, welche Elemente auf der Registrierungsseite stehen.',
	'ob.screens.row.action': 'Öffne diese Zeile.',
	'ob.screens.row.fallback':
		'Die Zeile ist durch die Suche oder den Filter ausgeblendet. Setze beides hier zurück.',
	'ob.screens.s3.title': 'Eingabeelemente',
	'ob.screens.s3.body':
		'Diese Elemente speichern die Eingabe eines Benutzers in einem Attribut des Schemas. Jedes Attribut des Attributschemas steht zur Wahl.',
	'ob.screens.s3.action': 'Ein Element anklicken, um es zum Bildschirm hinzuzufügen.',
	'ob.screens.s4.title': 'Wo der Wert gespeichert wird',
	'ob.screens.s4.body':
		'Die Einstellungen des hinzugefügten Elements. Wähle beim Speicherziel ein beliebiges Attribut, in dem der eingegebene Wert gespeichert wird.',
	'ob.screens.s5.title': 'Speichern',
	'ob.screens.s5.body': 'Anordnung und Einstellungen der Elemente nach Belieben ändern.',
	'ob.screens.s5.action': 'Zum Abschluss auf Speichern drücken. Die Anleitung endet dort.',

	'ob.secondFactor.title': 'Einen zweiten Faktor registrieren',
	'ob.secondFactor.desc': 'Registrieren Sie den zweiten Nachweis, den wichtige Vorgänge verlangen.',
	'ob.secondFactor.menu.title': 'Das Kontomenü',
	'ob.secondFactor.menu.body':
		'Ihre eigenen Anmeldemethoden und Ihre zweiten Faktoren verwalten Sie unter „Persönliche Einstellungen“, die Sie über das Kontomenü oben rechts öffnen.',
	'ob.secondFactor.menu.action': 'Klicken Sie auf das Konto-Symbol.',
	'ob.secondFactor.settings.title': 'Persönliche Einstellungen',
	'ob.secondFactor.settings.body':
		'Von hier gelangen Sie auf die Seite mit Ihren eigenen Einstellungen.',
	'ob.secondFactor.settings.action': 'Klicken Sie auf „Persönliche Einstellungen“.',
	'ob.secondFactor.settings.fallback':
		'Das Menü hat sich geschlossen. Klicken Sie erneut auf das Konto-Symbol.',
	'ob.secondFactor.keys.title': 'Ihr zweiter Faktor',
	'ob.secondFactor.keys.body':
		'Neben der Anmeldung mit einem Passkey verlangen wichtige Vorgänge, etwa das Wechseln eines Schlüssels oder das Ändern der Rolle eines Administrators, einen weiteren Nachweis. Diesen registrieren Sie in diesem Feld. Sie können einen Sicherheitsschlüssel registrieren.',
	'ob.secondFactor.keys.bodyTotp':
		'Neben der Anmeldung mit einem Passkey verlangen wichtige Vorgänge, etwa das Wechseln eines Schlüssels oder das Ändern der Rolle eines Administrators, einen weiteren Nachweis. Diesen registrieren Sie in diesem Feld. Sie können einen Sicherheitsschlüssel registrieren oder, in dieser Umgebung, eine Authenticator-App auf Ihrem Smartphone (TOTP).',
	'ob.secondFactor.add.title': 'Registrieren',
	'ob.secondFactor.add.body': 'Mit diesen Schaltflächen registrieren Sie einen zweiten Faktor.',
	'ob.secondFactor.add.bodyTotp':
		'Mit diesen Schaltflächen registrieren Sie entweder einen Sicherheitsschlüssel oder eine Authenticator-App (TOTP). Bei der Authenticator-App scannen Sie den angezeigten QR-Code und geben die 6-stellige Zahl ein, die die App anzeigt.',
	'ob.secondFactor.add.action':
		'Führen Sie die Registrierung bis zum Ende durch. Die Anleitung endet, sobald sie gelingt.',
	'ob.secondFactor.keys.bodyBlocked':
		'Neben der Anmeldung mit einem Passkey verlangen wichtige Vorgänge, etwa das Wechseln eines Schlüssels oder das Ändern der Rolle eines Administrators, einen weiteren Nachweis. Diesen verwalten Sie in diesem Feld. Im Moment lässt sich hier nichts Neues registrieren (die Frist zur Registrierung ist abgelaufen oder eine Wiederherstellung steht aus).',
	'ob.secondFactor.add.bodyBlocked':
		'In diesem Feld wird im Moment keine Schaltfläche zum Registrieren angezeigt, daher können Sie hier das Registrieren eines zweiten Faktors nicht üben.',
	'ob.secondFactor.add.actionBlocked':
		'Schließen Sie die Anleitung. Diesen Punkt können Sie in der Liste von Hand als erledigt markieren.',

	'ob.steps.label': 'Schritte: {name}',
	'ob.steps.progress': 'Fortschritt: {name}'
};
