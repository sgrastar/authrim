import type { jaTenants } from './ja';

export const deTenants: Record<keyof typeof jaTenants, string> = {
	'tn.create': 'Mandant anlegen',
	'tn.advanced': 'Erweiterte Einstellungen',
	'tn.default': 'Standard',

	'tn.list.intro':
		'Alle Mandanten dieser Installation. Öffnen Sie eine Zeile, um den Mandanten anzusehen, zu kopieren oder zu löschen.',
	'tn.list.title': 'Mandanten',
	'tn.list.noAccess': 'Sie haben keinen Zugriff auf Mandanten',
	'tn.list.loadFailed': 'Die Mandanten konnten nicht geladen werden',
	'tn.list.singleTenant':
		'Für die API ist keine eigene Domain eingerichtet, daher läuft diese Installation mit nur einem Mandanten. Mandanten können nicht angelegt, kopiert oder gelöscht werden.',
	'tn.list.search': 'Mandanten suchen',
	'tn.list.open': '{name} öffnen',
	'tn.list.empty': 'Noch keine Mandanten',
	'tn.list.noMatch': 'Keine passenden Mandanten',
	'tn.list.col.name': 'Name',
	'tn.list.col.id': 'Mandanten-ID',
	'tn.list.col.state': 'Zustand',
	'tn.list.col.created': 'Angelegt',
	'tn.list.col.updated': 'Geändert',

	'tn.state.provisioning': 'Wird eingerichtet',
	'tn.state.active': 'Aktiv',
	'tn.state.suspended': 'Ausgesetzt',
	'tn.state.frozen': 'Eingefroren',
	'tn.state.migration_read_only': 'Wird verschoben (nur lesen)',
	'tn.state.deleting': 'Wird gelöscht',
	'tn.state.deleted': 'Gelöscht',
	'tn.state.restore_pending': 'Wartet auf Wiederherstellung',
	'tn.state.restore_validating': 'Wiederherstellung wird geprüft',

	'tn.new.title': 'Mandant anlegen',
	'tn.new.desc':
		'Wählen Sie einen Namen und eine ID, um einen leeren Mandanten anzulegen. Er wird im Hintergrund eingerichtet und ist danach aktiv.',
	'tn.new.submit': 'Anlegen',

	'tn.f.name': 'Name',
	'tn.f.nameRequired': 'Geben Sie einen Namen ein',
	'tn.f.id': 'Mandanten-ID',
	'tn.f.idHint':
		'Kleinbuchstaben, Ziffern und Bindestriche (bis 63). Lässt sich später nicht ändern.',
	'tn.f.id.required': 'Geben Sie eine ID ein',
	'tn.f.id.format':
		'Kleinbuchstaben, Ziffern und Bindestriche, Anfang und Ende ein Buchstabe oder eine Ziffer (bis 63)',
	'tn.f.id.reserved': 'Diese ID ist für die Plattform reserviert',
	'tn.f.id.taken': 'Diese ID wird bereits verwendet',
	'tn.f.id.same': 'Die Kopie braucht eine andere ID als die Quelle',
	'tn.f.code': 'Mandantencode',
	'tn.f.codeHint':
		'Ein kurzer Code, mit dem der Mandant bei der Anmeldung gefunden wird. Leer gelassen, ist es die ID.',
	'tn.f.code.taken': 'Dieser Code wird bereits verwendet (leer gelassen, ist der Code die ID)',
	'tn.f.description': 'Beschreibung',
	'tn.f.isolation': 'Speicherort der Daten',

	'tn.isolation.tenant_exclusive': 'Eigener Speicher',
	'tn.isolation.tenant_exclusive.desc': 'Eine Datenbank nur für diesen Mandanten (empfohlen).',
	'tn.isolation.shared_pool': 'Gemeinsamer Pool',
	'tn.isolation.shared_pool.desc': 'Eine Datenbank, die sich mehrere Mandanten teilen.',

	'tn.toast.created': '{name} angelegt. Er ist aktiv, sobald er eingerichtet ist',
	'tn.toast.copied': '{name} angelegt. Er ist aktiv, sobald die Kopie fertig ist',
	'tn.toast.deleted': 'Löschen von {name} gestartet',

	'tn.error.cancelled': 'Nichts geändert: Die Identitätsprüfung wurde abgebrochen',
	'tn.error.defaultProtected': 'Der Standardmandant der Installation kann nicht gelöscht werden',
	'tn.error.invalid': 'Einige Werte wurden nicht angenommen.',
	'tn.error.forbidden': 'Dazu sind Sie nicht berechtigt',
	'tn.error.notFound': 'Der Mandant wurde nicht gefunden. Vielleicht ist er schon gelöscht',
	'tn.error.conflict':
		'Der Mandant wurde durch einen anderen Vorgang geändert. Laden Sie neu und versuchen Sie es erneut',
	'tn.error.rateLimited': 'Zu viele Anfragen. Warten Sie kurz und versuchen Sie es erneut',
	'tn.error.generic': 'Das hat nicht geklappt. Versuchen Sie es erneut',

	'tn.copy.action': 'Kopieren',
	'tn.copy.title': '{name} kopieren',
	'tn.copy.desc':
		'Legt aus diesem Mandanten einen neuen an. Wählen Sie, was kopiert wird. Signaturschlüssel werden nie kopiert: Der neue Mandant bekommt eigene.',
	'tn.copy.submit': 'Kopieren und anlegen',
	'tn.copy.defaultName': '{name} (Kopie)',
	'tn.copy.inDevelopment': 'In Entwicklung',
	'tn.copy.keysNote':
		'Nur ein aktiver Mandant kann kopiert werden. Beim Kopieren von Administratorzugriff oder Webhooks wird Ihre Identität geprüft.',
	'tn.copy.separateStepUps':
		'Administratorzugriff und Webhooks brauchen je eine eigene Identitätsprüfung und lassen sich nicht zusammen kopieren. Lassen Sie eines weg und richten Sie es im neuen Mandanten ein.',
	'tn.copy.group.configuration': 'Konfiguration',
	'tn.copy.group.applications': 'Apps und Integrationen',
	'tn.copy.group.people': 'Administratoren und Benutzer',
	'tn.copy.settings': 'Mandanteneinstellungen',
	'tn.copy.settings.desc': 'Anmeldemethoden, Sitzungen, Anmeldeseiten und weitere Einstellungen.',
	'tn.copy.secretSettings': 'Geheime Werte einschließen',
	'tn.copy.secretSettings.desc':
		'Kopiert auch Geheimnisse in den Einstellungen, etwa API-Schlüssel.',
	'tn.copy.flows': 'Serviceabläufe',
	'tn.copy.flows.desc':
		'Anmelde-, Registrierungs- und weitere Abläufe und wo sie verwendet werden.',
	'tn.copy.screens': 'Bildschirme',
	'tn.copy.screens.desc': 'Die Bildschirme, die die Abläufe zeigen.',
	'tn.copy.statements': 'Einwilligungsdokumente',
	'tn.copy.statements.desc':
		'Nutzungsbedingungen, Datenschutzhinweise und andere Dokumente, denen zugestimmt wird.',
	'tn.copy.clients': 'Apps (Clients)',
	'tn.copy.clients.desc': 'Registrierte Apps und ihre Einstellungen.',
	'tn.copy.samlProviders': 'SAML-Verbindungen (deaktiviert kopieren)',
	'tn.copy.samlProviders.desc':
		'SP- und IdP-Konfiguration als Entwürfe kopieren. Vor der Aktivierung einen Mapping Set im Zielmandanten auswählen und mit Level 2 bestätigen.',
	'tn.copy.clientCredentials': 'Client-Geheimnisse einschließen',
	'tn.copy.clientCredentials.desc': 'Kopiert auch die Geheimnisse der Apps unverändert.',
	'tn.copy.webhooks': 'Webhooks',
	'tn.copy.webhooks.desc': 'Wohin Ereignisse gesendet werden.',
	'tn.copy.webhookSecrets': 'Webhook-Signaturgeheimnisse einschließen',
	'tn.copy.webhookSecrets.desc':
		'Kopiert auch die Geheimnisse, mit denen Benachrichtigungen signiert werden.',
	'tn.copy.roles': 'Rollen',
	'tn.copy.roles.desc': 'In diesem Mandanten angelegte Rollen und ihre Berechtigungen.',
	'tn.copy.adminAccess': 'Administratoren',
	'tn.copy.adminAccess.desc': 'Rollenzuweisungen der Administratoren und Administratorgruppen.',
	'tn.copy.endUsers': 'Endbenutzer',
	'tn.copy.endUsers.desc': 'Die Konten der Personen, die sich anmelden, und ihre Attribute.',

	'tn.d.back': 'Alle Mandanten',
	'tn.d.loadFailed': 'Der Mandant konnte nicht geladen werden',
	'tn.d.notFound': 'Mandant nicht gefunden',
	'tn.d.overview': 'Überblick',
	'tn.d.none': 'Keine',
	'tn.d.note.deleting':
		'Dieser Mandant wird gelöscht. Die Anmeldung ist bereits gestoppt, die Daten werden im Hintergrund entfernt.',
	'tn.d.note.deleted': 'Dieser Mandant wurde gelöscht.',
	'tn.d.provisioning': 'Einrichtung',
	'tn.d.provisioningDesc': 'Der Mandant wird im Hintergrund eingerichtet und ist danach aktiv.',
	'tn.d.refresh': 'Aktualisieren',
	'tn.d.provisioningStatus': 'Status',
	'tn.d.provisioningKind': 'Art',
	'tn.d.provisioningStep': 'Aktueller Schritt',
	'tn.d.provisioningError': 'Letzter Fehler',
	'tn.d.provisioningUnknown': 'Der Stand der Einrichtung konnte nicht geladen werden.',

	'tn.prov.queued': 'In der Warteschlange',
	'tn.prov.running': 'Läuft',
	'tn.prov.waiting_retry': 'Wartet auf erneuten Versuch',
	'tn.prov.blocked': 'Gestoppt (Eingriff nötig)',
	'tn.prov.succeeded': 'Fertig',
	'tn.prov.canceled': 'Abgebrochen',
	'tn.prov.kind.create': 'Neuer Mandant',
	'tn.prov.kind.clone': 'Kopie',

	'tn.delete.title': 'Mandant löschen',
	'tn.delete.desc':
		'Stoppt die Anmeldung beim Mandanten sofort und entfernt alle seine Daten: Benutzer, Apps, Einstellungen und alles Weitere. Das lässt sich nicht rückgängig machen.',
	'tn.delete.action': 'Mandant löschen',
	'tn.delete.confirmTitle': '{name} löschen?',
	'tn.delete.confirmBody':
		'Die Anmeldung beim Mandanten „{id}“ stoppt sofort, alle Daten werden im Hintergrund entfernt. Das lässt sich nicht rückgängig machen. Ihre Identität wird geprüft.',
	'tn.delete.defaultNote': 'Der Standardmandant kann nicht gelöscht werden.',

	'tn.dom.title': 'Eigene Domains',
	'tn.dom.desc':
		'Hostnamen, unter denen der Mandant mit eigener Adresse erreichbar ist. Die primäre Domain ist der Aussteller (iss) seiner Tokens.',
	'tn.dom.add': 'Domain hinzufügen',
	'tn.dom.noAccess': 'Sie haben keinen Zugriff auf eigene Domains',
	'tn.dom.loadFailed': 'Die eigenen Domains konnten nicht geladen werden',
	'tn.dom.empty': 'Keine eigenen Domains',
	'tn.dom.emptyBody': 'Der Mandant läuft unter seiner Standardadresse.',
	'tn.dom.col.hostname': 'Hostname',
	'tn.dom.col.status': 'Zustand',
	'tn.dom.col.actions': 'Aktionen',
	'tn.dom.primary': 'Primär',
	'tn.dom.actions': 'Aktionen für {hostname}',
	'tn.dom.status.active': 'Aktiv',
	'tn.dom.status.pending': 'Wartet auf Prüfung',
	'tn.dom.status.pending_manual': 'Wartet auf manuelle Einrichtung',
	'tn.dom.status.failed': 'Registrierung fehlgeschlagen',
	'tn.dom.status.inactive': 'Inaktiv',
	'tn.dom.makePrimary': 'Zur primären Domain machen',
	'tn.dom.check': 'Erneut prüfen',
	'tn.dom.markVerified': 'Als geprüft markieren',
	'tn.dom.remove': 'Entfernen',
	'tn.dom.primary.title': '{hostname} zur primären Domain machen?',
	'tn.dom.primary.body':
		'Der Aussteller (iss) der Tokens und die Anmeldeadresse des Mandanten werden zu https://{hostname}. Apps, die einen festen Aussteller prüfen, lehnen die Tokens ab, bis ihre Einstellungen angepasst sind.',
	'tn.dom.manual.title': '{hostname} als geprüft markieren?',
	'tn.dom.manual.body':
		'Authrim prüft diese Domain nicht. Fahren Sie erst fort, wenn ihr DNS auf diese Installation zeigt und das Zertifikat bereitsteht. Als geprüft markiert, führt der Hostname zum Mandanten.',
	'tn.dom.remove.title': '{hostname} entfernen?',
	'tn.dom.remove.body': 'Der Hostname führt nicht mehr zum Mandanten.',
	'tn.dom.remove.bodyPrimary':
		'Das ist die primäre Domain. Wird sie entfernt, gehen Aussteller (iss) und Anmeldeadresse auf die Standardadresse zurück, und Apps mit festem Aussteller lehnen die Tokens ab.',
	'tn.dom.record.ownership': 'Inhaberschaft',
	'tn.dom.record.certificate': 'Zertifikat',
	'tn.dom.record.name': 'Name',
	'tn.dom.record.value': 'Wert',
	'tn.dom.records.title': 'Für {hostname} zu veröffentlichende Einträge',
	'tn.dom.records.desc':
		'Veröffentlichen Sie sie wie beschrieben und wählen Sie dann „Erneut prüfen“.',
	'tn.dom.manualNote':
		'Für diese Installation sind keine Cloudflare Custom Hostnames eingerichtet, daher werden DNS und Zertifikate manuell eingerichtet. Wählen Sie danach „Als geprüft markieren“.',
	'tn.dom.add.title': 'Domain hinzufügen',
	'tn.dom.add.descCloudflare':
		'Die Domain wird bei Cloudflare registriert, und die Einträge für die Prüfung von Inhaberschaft und Zertifikat werden angezeigt.',
	'tn.dom.add.descManual':
		'In dieser Installation werden DNS und Zertifikate manuell eingerichtet. Wählen Sie danach „Als geprüft markieren“.',
	'tn.dom.add.submit': 'Hinzufügen',
	'tn.dom.f.hostname': 'Hostname',
	'tn.dom.f.hostnameHint': 'Ohne https:// und ohne Pfad.',
	'tn.dom.f.hostnameInvalid': 'Das ist kein gültiger Domainname (zum Beispiel login.example.com)',
	'tn.dom.f.hostnameTaken': 'Diese Domain wurde bereits hinzugefügt',
	'tn.dom.f.primary': 'Zur primären Domain machen',
	'tn.dom.f.primaryHint':
		'Sie wird primär, sobald sie aktiv ist, was den Aussteller (iss) der Tokens ändert. Ist sie nicht sofort aktiv, wählen Sie später „Zur primären Domain machen“.',
	'tn.dom.toast.added': '{hostname} hinzugefügt',
	'tn.dom.toast.primary': '{hostname} ist jetzt die primäre Domain',
	'tn.dom.toast.verified': '{hostname} als geprüft markiert',
	'tn.dom.toast.checked': '{hostname} geprüft',
	'tn.dom.toast.removed': '{hostname} entfernt',
	'tn.dom.error.lite':
		'Der Mandant nutzt die schlanken Anmeldeseiten, daher kann sich die primäre Domain nicht ändern. Schalten Sie sie zuerst aus.',
	'tn.dom.error.liteChanging':
		'Die Einstellung der schlanken Anmeldeseiten wird gerade geändert. Versuchen Sie es in einigen Sekunden erneut',
	'tn.dom.error.notFound': 'Die Domain wurde nicht gefunden. Vielleicht ist sie schon entfernt',
	'tn.dom.toast.addedFailed':
		'{hostname} wurde hinzugefügt, aber die Registrierung bei Cloudflare ist fehlgeschlagen: {reason}',
	'tn.dom.unknownReason': 'es wurde kein Grund genannt',
	'tn.dom.failedNote':
		'Die Registrierung einiger Domains bei Cloudflare ist fehlgeschlagen ({hostnames}). Prüfen Sie die Einrichtung, entfernen Sie sie und fügen Sie sie erneut hinzu.',
	'tn.dom.record.howTxt': 'Fügen Sie ihn als TXT-Eintrag im DNS der Domain hinzu.',
	'tn.dom.record.howHttp': 'Stellen Sie den Inhalt unverändert unter dieser URL bereit.',
	'tn.dom.record.url': 'URL',
	'tn.dom.record.body': 'Inhalt'
};
