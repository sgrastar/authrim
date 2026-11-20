/** Deutsche Texte der Serviceablauf-Seiten. */
import type { jaServiceFlows } from './ja';

export const deServiceFlows: Record<keyof typeof jaServiceFlows, string> = {
	'sf.rp.missing.grant_types': 'Erlaubte Grants',
	'sf.rp.enableRequires': 'Zum Aktivieren erforderliche Einstellungen',
	'sf.rp.disabledNote':
		'Solange der Client deaktiviert ist, sind Anmeldung und Tokennutzung nicht möglich. Widerruf und Abmeldung bleiben möglich.',
	'sf.rp.missing.redirect_uris': 'Callback-URLs',
	'sf.rp.missing.jwks': 'Öffentliche Signaturschlüssel oder JWKS-URL',
	'sf.rp.missing.client_secret': 'Client-Geheimnis',
	'sf.rp.missing.require_pkce': 'Verpflichtendes PKCE',
	'sf.rp.missing.token_endpoint_auth_method': 'Mit den Grants kompatible Client-Authentifizierung',
	'sf.rp.missing.response_types': 'Mit den Grants kompatible Antworttypen',
	'sf.rp.missing.sector_identifier_uri': 'Sektor für paarweise Kennungen',
	'sf.rp.missing.backchannel_client_notification_endpoint': 'CIBA-Benachrichtigungsendpunkt',
	'sf.rp.missing.configuration': 'Client-Konfiguration',

	'sf.rp.callbacksMissing':
		'Es wurde noch keine Callback-URL hinterlegt. Die Anmeldung ist daher noch nicht möglich. Ergänzen Sie die URL in den Verbindungsdetails.',
	'sf.draft.skip': 'Später eingeben',
	'sf.draft.enterNow': 'Jetzt eingeben',
	'sf.draft.saved': 'Als Entwurf gespeichert',
	'sf.draft.metadataRequired':
		'Zum Aktivieren werden Entity-ID und Endpunkt-URL benötigt. IdP-Verbindungen benötigen auch ein Signaturzertifikat. Sie können Metadaten importieren.',
	'sf.draft.openDetails': 'Verbindungsdetails öffnen',
	'sf.import.mode.xml': 'XML einfügen',
	'sf.metadata.xmlHint': 'Eingefügtes Metadaten-XML wird automatisch eingelesen.',
	'sf.metadata.wrongRoleSp':
		'Diese Verbindung benötigt SP-Metadaten. Die importierten Metadaten beschreiben einen IdP.',
	'sf.metadata.wrongRoleIdp':
		'Diese Verbindung benötigt IdP-Metadaten. Die importierten Metadaten beschreiben einen SP.',
	'sf.metadata.fetchFailed':
		'Metadaten konnten nicht abgerufen werden. Prüfen Sie die öffentliche HTTPS-URL und die Serverantwort.',
	'sf.metadata.invalidXml':
		'SAML-Metadaten-XML konnte nicht gelesen werden. Prüfen Sie Inhalt und Dateigröße.',
	'sf.metadata.aggregate':
		'Diese Metadaten enthalten mehrere Entitäten. Verwenden Sie den Metadatenimport für Föderationen.',
	'sf.draft.noMetadata': 'Es wurden noch keine Metadaten hinterlegt.',

	'sf.live.status': 'Verbindungsstatus',
	'sf.live.enable': 'Aktivieren',
	'sf.live.disable': 'Deaktivieren',
	'sf.live.saveFirst': 'Speichern Sie Einstellungen und Mapping vor dem Aktivieren.',
	'sf.live.mappingRequired': 'Zum Aktivieren ist ein gespeichertes, gültiges Mapping erforderlich.',
	'sf.live.trustRequired':
		'Prüfen Sie Zertifikat und Metadatenvertrauen. Die aktuellen Einstellungen erlauben keine Aktivierung.',
	'sf.live.activationRejected':
		'Der Server hat die Verbindung deaktiviert gelassen. Prüfen Sie Zertifikat und Vertrauenseinstellungen.',
	'sf.live.activationFailed':
		'Der Status konnte nicht geändert werden. Prüfen Sie gespeichertes Mapping und Vertrauenseinstellungen und versuchen Sie es erneut.',
	'sf.live.conflict':
		'Die Verbindung wurde auf dem Server geändert. Ihre Eingaben bleiben erhalten. Laden Sie die Änderungen neu.',
	'sf.live.reload': 'Gespeicherte Verbindung neu laden',
	'sf.live.reloadTitle': 'Gespeicherte Einstellungen neu laden?',
	'sf.live.reloadBody':
		'Ungespeicherte Änderungen in diesem Formular verwerfen und die Servereinstellungen laden.',
	'sf.live.authReadonly':
		'Gespeicherte Authentifizierungsmethode: {method}. Sie kann hier nicht geändert werden.',
	'sf.live.unset': 'Nicht festgelegt',
	'sf.live.pkceUnset': 'PKCE ist nicht festgelegt. Dieser Wert wird beibehalten.',
	'sf.live.accountOptions': 'Kontooptionen',
	'sf.live.requireVerified': 'Verifizierte E-Mail-Adresse erforderlich',
	'sf.live.issuerMismatch': 'Der ermittelte Issuer stimmt nicht mit Ihrer Eingabe überein.',
	'sf.live.discoveryFailed':
		'Die Anbieterkonfiguration konnte nicht gelesen werden. Versuchen Sie es erneut.',
	'sf.live.inboundMapping':
		'Diese Seite bearbeitet grundlegende Eingangseinstellungen. Zur Aktivierung ist ein gültiges bestehendes Eingangs-Mapping erforderlich; es kann hier nicht bearbeitet werden.',
	'sf.live.enabled': 'Aktiviert',
	'sf.live.disabled': 'Deaktiviert',
	'sf.live.saved': 'Änderungen gespeichert.',
	'sf.live.settings': 'Anbietereinstellungen',

	'sf.create.invalid': 'Prüfen Sie die erforderlichen Verbindungsfelder.',
	'sf.create.unavailable': 'Sie dürfen diese Verbindung nicht erstellen.',
	'sf.create.failed':
		'Verbindung konnte nicht erstellt werden. Ihre Eingaben bleiben erhalten. Versuchen Sie es erneut.',
	'sf.create.navigationFailed':
		'Die Verbindung wurde gespeichert. Öffnen Sie die Einstellungen erneut.',
	'sf.create.saved': 'Verbindung gespeichert',
	'sf.create.save': 'Speichern und Einstellungen öffnen',
	'sf.create.spDraft':
		'Wird deaktiviert gespeichert. Konfigurieren Sie das Mapping im nächsten Schritt. NameID verwendet die Mandantenstandardwerte.',

	'cm.releaseFailed':
		'Die Freigabeanforderungen wurden nicht erfüllt. Es würde keine SAML-Antwort ausgestellt.',
	'cm.otherConnections': 'Weitere Verbindungen mit diesem Set: {names}.',
	'cm.connections': 'Apps und Dienste',
	'cm.create': 'Mapping Set erstellen',
	'cm.options': 'Mapping-Set-Einstellungen',
	'cm.description': 'Beschreibung',
	'cm.profile': 'Zielprofil',
	'cm.catalog': 'Quellkatalog',
	'cm.saveBind': 'Speichern und für diese Verbindung verwenden',
	'cm.saved': 'Mapping Set gespeichert und mit dieser Verbindung verknüpft.',
	'cm.readonly':
		'Dieses Set oder diese Verknüpfung kann hier nicht bearbeitet werden. Protokoll, Profil oder gespeicherte Einstellungen werden nicht unterstützt. Die Prüfung mit einem Testbenutzer ist weiterhin möglich.',
	'cm.conflict':
		'Das Set wurde auf dem Server geändert. Vor dem nächsten Speichern neu laden; Ihre Änderungen bleiben hier sichtbar.',
	'cm.reload': 'Gespeichertes Set neu laden',
	'cm.stageFailed':
		'Die Aktivierung wurde nicht abgeschlossen (Schritt: {stage}). Die Verbindung wurde nicht neu verknüpft. Laden Sie das gespeicherte Set neu.',
	'cm.unknown':
		'Das Speicherergebnis ist unbekannt. Wiederholen Sie dieselbe Anfrage. Die Verbindung wurde noch nicht neu verknüpft.',
	'cm.bindingFailed':
		'Das Set ist gespeichert, aber die Verknüpfung ist fehlgeschlagen. Wiederholen Sie nur die Verknüpfung.',
	'cm.retryBinding': 'Nur Verknüpfung wiederholen',
	'cm.impactTitle': 'Gemeinsames Mapping Set aktualisieren?',
	'cm.impact':
		'Dieses Set hat {count} Verweise, einschließlich Verbindungen und Standardwerten. Speichern ändert den Inhalt für alle Verbindungen, die es verwenden.',
	'cm.impactIncomplete':
		'Mindestens {count} Verweise verwenden dieses Set. Die Prüfung ist unvollständig; weitere Verbindungen können betroffen sein. Speichern aktualisiert den gemeinsamen Inhalt.',
	'cm.confirmImpact': 'Gemeinsames Set aktualisieren',
	'cm.discardTitle': 'Mapping-Änderungen verwerfen?',
	'cm.discardBody':
		'Wechseln oder Neuladen verwirft die aktuellen Änderungen und eine ausstehende Verknüpfungswiederholung.',
	'cm.beforeConsent': 'Vor der Einwilligung',
	'cm.afterConsent': 'Nach der Einwilligung',
	'cm.deferred': 'Auswertung bei der Anmeldung',
	'cm.explainSaved':
		'Diese Erklärung verwendet die gespeicherte Verbindung. Speichern und erneut prüfen, um aktuelle Änderungen zu sehen.',
	'cm.awaitingConsent': 'Die Freigabe wartet auf Einwilligung.',
	'cm.identifierDeferred':
		'Kennungen, die Kontomaterial benötigen, werden für Testbenutzer nicht erzeugt. Die Anmeldung wertet sie nach der Einwilligung aus.',
	'sf.part.where': 'Was hinzugefügt werden soll',
	'sf.part.kind': 'Art',
	'sf.part.rp-app': 'App-Details',
	'sf.part.rp-redirect': 'Weiterleitungs-URIs',
	'sf.part.rp-signin': 'Anmeldemethode',
	'sf.part.rp-info': 'Benutzerinformationen',
	'sf.part.rp-share': 'Angaben von Authrim für die App',
	'sf.part.sp-import': 'Angaben des Dienstes',
	'sf.part.share': 'Ihre Angaben für die Gegenstelle',
	'sf.part.sp-attrs': 'Attribute und Kennung',
	'sf.part.test': 'Verbindung testen',
	'sf.part.providerDetails': 'Angaben des Anbieters',
	'sf.part.attrsTaken': 'Zu übernehmende Attribute',
	'sf.part.link': 'Personen zuordnen',
	'sf.part.mapping-schemas': 'Eingabe- und Ausgabeschemas',
	'sf.part.mapping-sets': 'Zuordnungssätze',
	'sf.part.additional': 'Abzufragende Felder',
	'sf.part.consent-statements': 'Einwilligungstexte',
	'sf.part.consent-policies': 'Einwilligungsrichtlinien',
	'sf.part.role': 'Zuzuweisende Rollen',
	'sf.part.activate': 'Prüfen und aktivieren',

	'sf.group.receives': 'Was die App erhält',
	'sf.group.mapping': 'Zuordnung',
	'sf.group.consent': 'Einwilligung',
	'sf.group.role': 'Rollenzuweisung',
	'sf.group.live': 'Live schalten',
	'sf.group.response': 'Anmeldeantwort',
	'sf.group.check': 'Prüfung',
	'sf.group.accounts': 'Konten',
	'sf.group.additional': 'Zusätzliche Eingaben',

	'sf.protocol.rp': 'OpenID Connect (Relying Party)',
	'sf.protocol.sp': 'SAML (Service Provider)',
	'sf.protocol.op': 'OpenID Connect (OpenID Provider)',
	'sf.protocol.idp': 'SAML (Identity Provider)',

	'sf.role.out.badge': 'Authrim meldet Personen an',
	'sf.role.in.badge': 'Personen melden sich anderswo an',
	'sf.role.rp.line': 'Personen melden sich über Authrim bei dieser App an.',
	'sf.role.sp.line': 'Personen melden sich über Authrim bei diesem Dienst an.',
	'sf.role.in.line':
		'Personen melden sich bei diesem Anbieter an; Authrim erfährt von ihm, wer sie sind.',

	'sf.leave.title': 'Diese Verbindung verwerfen?',
	'sf.leave.body':
		'Bis Sie zu den Einstellungen weitergehen, wird nichts gespeichert. Ihre bisherigen Eingaben gehen verloren.',
	'sf.leave.confirm': 'Verwerfen',
	'sf.leave.keep': 'Weiter bearbeiten',

	'sf.consent.tos': 'Nutzungsbedingungen (v3)',
	'sf.consent.privacy': 'Datenschutzerklärung (v2)',
	'sf.consent.marketing': 'Nutzung für Marketing (v1)',

	'sf.error.wildcard': 'Keine Platzhalter und keine Fragmente.',
	'sf.error.redirect':
		'Verwenden Sie https://, http://localhost oder ein App-Schema wie com.example.app:/callback.',
	'sf.error.https': 'Verwenden Sie eine https://-Adresse.',
	'sf.error.entityId': 'Verwenden Sie eine https://-Adresse oder eine urn:.',

	'sf.name.newApp': 'Neue App',
	'sf.name.newProvider': 'Neuer Anbieter',
	'sf.name.newConnection': 'Neue Verbindung',

	'sf.row.kind': 'Art',
	'sf.row.name': 'Name',
	'sf.row.appType': 'App-Typ',
	'sf.row.clientAuth': 'Client-Authentifizierung',
	'sf.row.pkce': 'PKCE',
	'sf.row.scopes': 'Scopes',
	'sf.row.importedFrom': 'Importiert aus',
	'sf.row.entityId': 'Entity-ID',
	'sf.row.identifier': 'Kennung',
	'sf.row.attributes': 'Attribute',
	'sf.row.minAuth': 'Mindest-Anmeldestärke',
	'sf.row.askConsent': 'Einwilligung einholen',
	'sf.row.test': 'Verbindung testen',
	'sf.row.issuer': 'Aussteller',
	'sf.row.clientId': 'Client-ID',
	'sf.row.mappingSet': 'Zuordnungssatz',
	'sf.row.role': 'Rolle',
	'sf.row.kind.rp': 'OpenID-Connect-App (RP)',
	'sf.row.kind.sp': 'SAML-Dienst (SP)',
	'sf.row.kind.op': 'OpenID-Connect-Anbieter (OP)',
	'sf.row.kind.idp': 'SAML-Identitätsanbieter (IdP)',
	'sf.value.notSet': 'Nicht festgelegt',
	'sf.value.required': 'Pflicht',
	'sf.value.notRequired': 'Nicht erforderlich',
	'sf.value.yes': 'Ja',
	'sf.value.no': 'Nein',
	'sf.value.passed': 'Bestanden',
	'sf.value.notRun': 'Nicht ausgeführt',
	'sf.value.byHand': 'Manuell eingegeben',
	'sf.value.issuerFromConfig': 'Aus der Konfiguration des Anbieters gelesen',

	'sf.appType.web': 'Web-App mit Server',
	'sf.appType.spa': 'Single-Page-App',
	'sf.appType.native': 'Native App',
	'sf.appType.web.desc': 'Bewahrt ein Client-Geheimnis auf dem Server auf.',
	'sf.appType.spa.desc': 'Läuft im Browser und kann kein Geheimnis bewahren.',
	'sf.appType.native.desc':
		'Auf einem Smartphone oder Computer installiert; kann kein Geheimnis bewahren.',

	'sf.link.verified-email': 'Automatisch über bestätigte E-Mail-Adresse verknüpft',
	'sf.link.manual': 'Nicht automatisch verknüpft',
	'sf.link.option.verified-email': 'Automatisch über bestätigte E-Mail verknüpfen',
	'sf.link.option.verified-email.desc':
		'Meldet der Anbieter die Adresse als bestätigt und hat ein Konto sie, meldet sich die Person an diesem Konto an.',
	'sf.link.option.manual': 'Nicht automatisch verknüpfen',
	'sf.link.option.manual.desc':
		'Personen, deren E-Mail-Adresse bereits ein Konto hat, werden gebeten, sich wie gewohnt anzumelden und den Anbieter auf ihrer Kontoseite zu verknüpfen.',
	'sf.link.lead':
		'Ein einmal verknüpftes Anbieterkonto findet seine Person über diese Verknüpfung. Hier wird festgelegt, wie noch nicht verknüpfte Personen einem bestehenden Konto zugeordnet werden.',
	'sf.link.idpSource':
		'Für die Zuordnung wird die per Mapping übernommene E-Mail-Adresse verwendet.',
	'sf.link.trustWarn':
		'Auch unbestätigte Adressen werden mit bestehenden Konten verknüpft – Personen können so mit fremden Konten verknüpft werden.',
	'sf.link.label': 'Wie Personen Konten zugeordnet werden',

	'sf.schema.authrim': 'Authrim-Benutzer',
	'sf.schema.authrimExtended': 'Authrim-Benutzer mit benutzerdefinierten Attributen',
	'sf.schema.serviceReceives': 'Claims oder Attribute, die der Dienst erhält',
	'sf.schema.standardPlusCustom': 'Standard-Claims plus benutzerdefinierte Claims',
	'sf.schema.providerStandard': 'Die Standard-Claims oder -Attribute des Anbieters',

	'sf.wizard.title': 'Serviceablauf hinzufügen',
	'sf.wizard.description':
		'Fügen Sie eine Verbindung zu einer App, einem Dienst oder einem Anbieter hinzu, oder einen Ablauf zur Registrierung und Anmeldung von Personen.',
	'sf.wizard.stepsNote': 'Weitere Schritte erscheinen, sobald Sie die Art gewählt haben.',
	'sf.wizard.finish': 'Weiter zu den Einstellungen',
	'sf.wizard.whereLabel': 'Was möchten Sie hinzufügen?',
	'sf.wizard.kindLabel': 'Welche Art?',
	'sf.wizard.out.label': 'Eine App oder einen Dienst über Authrim anmelden lassen',
	'sf.wizard.out.desc':
		'Authrim ist der Identitätsanbieter (IdP, bei OpenID Connect der OP). Eine App oder ein Dienst schickt seine Personen zur Anmeldung hierher.',
	'sf.wizard.in.label': 'Personen über einen anderen Anbieter anmelden lassen',
	'sf.wizard.in.desc':
		'Authrim ist die Relying Party (RP, bei SAML der SP). Personen melden sich bei einem Anbieter wie einem Firmenverzeichnis an, und Authrim vertraut dem Ergebnis.',
	'sf.wizard.kind.rp.label': 'Eine App, die OpenID Connect verwendet',
	'sf.wizard.kind.rp.desc':
		'Eine Web-App, Single-Page-App oder native App. Sie erhält eine Client-ID und schickt Personen zur Anmeldung zu Authrim.',
	'sf.wizard.kind.sp.label': 'Ein Dienst, der SAML verwendet',
	'sf.wizard.kind.sp.desc':
		'Ein SaaS-Produkt, ein internes Geschäftssystem oder der Dienst eines Partners, der eine SAML-Anmeldung entgegennimmt. Sie tauschen Metadaten mit ihm aus.',
	'sf.wizard.kind.op.label': 'Ein Anbieter, der OpenID Connect verwendet',
	'sf.wizard.kind.op.desc':
		'Ein Verzeichnis oder Anmeldedienst mit einer Aussteller-Adresse. Sie registrieren Authrim dort und erhalten eine Client-ID.',
	'sf.wizard.kind.idp.label': 'Ein Anbieter, der SAML verwendet',
	'sf.wizard.kind.idp.desc':
		'Ein Identitätsanbieter eines Unternehmens oder einer Hochschule. Sie tauschen SAML-Metadaten mit ihm aus.',

	'sf.status.done': 'Konfiguriert',
	'sf.status.partial': 'Teilweise festgelegt',
	'sf.status.todo': 'Noch nicht festgelegt',
	'sf.status.active': 'Aktiv',
	'sf.status.notActive': 'Nicht aktiv',
	'sf.status.draft': 'Entwurf',
	'sf.blurb.rp': 'Eine App, die sich über Authrim anmeldet (OpenID Connect)',
	'sf.blurb.sp': 'Ein Dienst, der sich über Authrim anmeldet (SAML)',
	'sf.blurb.op': 'Ein Anbieter, über den sich Personen anmelden (OpenID Connect)',
	'sf.blurb.idp': 'Ein Anbieter, über den sich Personen anmelden (SAML)',
	'sf.detail.back': 'Serviceabläufe',
	'sf.detail.signIn': 'Anmelden',
	'sf.detail.signInPage': 'Anmeldeseite',
	'sf.detail.peopleChoose': 'Personen wählen „{name}“',
	'sf.detail.overview': 'Übersicht',
	'sf.detail.authrimDoes': 'Was Authrim tut',
	'sf.detail.yourUsers': 'Ihre Benutzer',
	'sf.detail.whoSignsIn': 'Wer sich anmeldet',
	'sf.detail.active': 'Diese Verbindung ist aktiv. Im Mock wurde nirgends etwas geändert.',
	'sf.detail.entered': 'Ihre Eingaben',
	'sf.detail.todo': 'Noch zu erledigen',
	'sf.detail.allSet': 'Alles ist festgelegt. Öffnen Sie „{step}“, um die Verbindung einzuschalten.',
	'sf.detail.stillRequired': 'Noch erforderlich: {list}.',
	'sf.detail.testFirst': 'Führen Sie vor der Aktivierung den Test aus.',
	'sf.detail.enteredOnOverview': 'Ihre Eingaben finden Sie in der Übersicht.',
	'sf.detail.activate': 'Aktivieren',

	'sf.test.run': 'Test ausführen',
	'sf.test.again': 'Erneut ausführen',
	'sf.test.results': 'Testergebnisse',
	'sf.test.note': 'Hinweis',
	'sf.test.toGoOn':
		'Führen Sie den Test aus, um fortzufahren. Nach jeder Änderung können Sie ihn erneut ausführen.',
	'sf.test.metadataRead':
		'Die Metadaten wurden gelesen und der Signaturalgorithmus wird akzeptiert',

	'sf.partner.app': 'App',
	'sf.partner.service': 'Dienst',
	'sf.partner.provider': 'Anbieter',
	'sf.ours.lead':
		'Geben Sie diese Angaben an die Gegenstelle ({partner}) weiter, damit sie Authrim registrieren kann. Jede Angabe hat eine Schaltfläche zum Kopieren.',
	'sf.ours.copy': '{label} kopieren',
	'sf.ours.download': 'Metadaten von Authrim herunterladen',
	'sf.ours.metadataUrl': 'Metadaten-Adresse',
	'sf.ours.ssoUrl': 'Single-Sign-on-Adresse',
	'sf.ours.sloUrl': 'Single-Logout-Adresse',
	'sf.ours.signingCert': 'Signaturzertifikat',
	'sf.ours.acsUrl': 'Adresse der Anmeldeantwort (ACS)',
	'sf.ours.discovery': 'Discovery-Dokument',
	'sf.ours.authorizeUrl': 'Autorisierungsadresse',
	'sf.ours.tokenUrl': 'Token-Adresse',
	'sf.ours.keys': 'Schlüssel',
	'sf.ours.redirectUri': 'Weiterleitungs-URI',
	'sf.ours.signOutRedirectUri': 'Weiterleitungs-URI nach der Abmeldung',

	'sf.metadata.urlHint':
		'Authrim lädt und prüft diese URL auf dem Server. Erst Speichern oder Importieren übernimmt die geprüften Metadaten.',
	'sf.metadata.chooseFile': 'Wählen Sie eine XML-Metadatendatei.',
	'sf.metadata.tooLarge': 'Metadaten für eine Verbindung dürfen höchstens 1 MiB groß sein.',
	'sf.metadata.wrongRole': 'Die Metadatenrolle passt nicht zu dieser Verbindung.',
	'sf.metadata.failed': 'Die Metadaten konnten nicht geprüft werden. Versuchen Sie es erneut.',
	'sf.metadata.certificates': '{count} öffentliche Signaturzertifikate',
	'sf.metadata.noCertificate': 'Diese Metadaten enthalten kein öffentliches Signaturzertifikat.',
	'sf.metadata.previewOnly': 'Nur Vorschau. Es wurde noch nichts gespeichert.',
	'sf.metadata.title': 'Metadaten importieren',
	'sf.metadata.permissions':
		'Die Vorschau erfordert die Berechtigung zum Erstellen von Providern. Der Import erfordert zusätzlich die Metadaten-Importberechtigung. Manuelle Änderungen erfordern die Provider-Updateberechtigung.',
	'sf.metadata.mappingDirty':
		'Speichern oder verwerfen Sie ausstehende Mapping-Änderungen vor dem Import.',
	'sf.metadata.confirm': 'Metadatenimport bestätigen',
	'sf.metadata.confirmBody':
		'Die geprüften Metadaten importieren? Gespeichertes Mapping und benutzerdefinierte Einstellungen bleiben erhalten.',
	'sf.metadata.dirtyConfirm':
		'Ungespeicherte allgemeine Änderungen verwerfen und die geprüften Metadaten importieren? Gespeichertes Mapping und benutzerdefinierte Einstellungen bleiben erhalten.',
	'sf.metadata.discard': 'Metadatenvorschau verwerfen',
	'sf.import.how.service': 'Wie Authrim die Angaben des Dienstes erhält',
	'sf.import.how.provider': 'Wie Authrim die Angaben des Anbieters erhält',
	'sf.import.mode.file': 'Datei hochladen',
	'sf.import.mode.manual': 'Manuell eingeben',
	'sf.import.urlHint': 'Authrim liest sie jetzt und prüft sie danach täglich erneut.',
	'sf.import.read': 'Metadaten lesen',
	'sf.import.found': 'Gefundene Angaben',
	'sf.import.file': 'Metadatendatei',
	'sf.import.usingFile': 'Verwendet wird {file}, zuvor ausgewählt.',

	'sf.rp.nameHint': 'Wird Ihren Administratoren und auf dem Einwilligungsbildschirm angezeigt.',
	'sf.rp.issuerNote':
		'Der Aussteller gehört zu diesem Mandanten. Er ist für alle Apps gleich und lässt sich hier nicht ändern.',
	'sf.rp.redirectHint':
		'Wohin Authrim Personen nach der Anmeldung zurückschickt. Nur exakte Adressen.',
	'sf.rp.addRedirect': 'Weiterleitungs-URI hinzufügen',
	'sf.rp.authLabel': 'Wie die App ihre Identität nachweist',
	'sf.rp.auth.basic': 'Client-Geheimnis im Header',
	'sf.rp.auth.basic.desc': 'Die übliche Wahl für eine App mit Server.',
	'sf.rp.auth.post': 'Client-Geheimnis im Body',
	'sf.rp.auth.post.desc': 'Für Systeme, die den Header nicht setzen können.',
	'sf.rp.auth.jwt': 'Signierte Anfrage',
	'sf.rp.auth.jwt.desc':
		'Weist sich mit einem privaten Schlüssel aus; es wird kein Geheimnis übertragen.',
	'sf.rp.auth.none': 'Keine',
	'sf.rp.auth.none.desc':
		'Für Apps, die kein Geheimnis bewahren können, etwa Apps, die im Browser laufen oder auf einem Smartphone oder Computer installiert sind. Geschützt allein durch PKCE.',
	'sf.rp.pkceOnly':
		'Diese Art von App kann kein Geheimnis bewahren und meldet sich daher nur mit PKCE an.',
	'sf.rp.requirePkce': 'PKCE verlangen',
	'sf.rp.pkceAlways': 'Immer eingeschaltet für Apps, die kein Geheimnis bewahren können.',
	'sf.rp.pkceRecommended': 'Für jede App empfohlen.',
	'sf.rp.scopesTitle': 'Was die App anfordern darf',
	'sf.rp.scope.openid': 'Pflicht: Die Person anmelden.',
	'sf.rp.scope.profile': 'Name und grundlegendes Profil.',
	'sf.rp.scope.email': 'E-Mail-Adresse und ob sie bestätigt ist.',
	'sf.rp.scope.offline': 'Angemeldet bleiben, nachdem die Person weg ist.',
	'sf.rp.openidRequired': 'Eine OpenID-Connect-App muss {scope} anfordern.',
	'sf.rp.userInfo': 'An die App gesendete Benutzerinformationen',
	'sf.rp.userInfoHint':
		'Welche Regeln die Claims im ID-Token und in UserInfo bestimmen. Ohne Satz läuft keine Zuordnung.',

	'sf.set.choose': 'Zuordnungssatz wählen',
	'sf.set.tenantDefault': 'Vorgabe des Mandanten übernehmen',
	'sf.set.staff': 'Satz für Beschäftigte',
	'sf.set.none': 'Keine zusätzliche Zuordnung',
	'sf.set.minimal': 'Minimal: nur die Kennung',

	'sf.sp.nameIdLabel': 'Wie die Person gegenüber dem Dienst identifiziert wird',
	'sf.sp.nameIdHint':
		'Für jeden Dienst eine andere Kennung, damit zwei Dienste dieselbe Person nicht abgleichen können.',
	'sf.sp.nameId.persistent': 'Dauerhaft, für jeden Dienst verschieden',
	'sf.sp.nameId.transient': 'Ändert sich bei jeder Anmeldung',
	'sf.sp.nameId.email': 'E-Mail-Adresse',
	'sf.sp.nameId.unspecified': 'Nicht angegeben',
	'sf.sp.attrsLabel': 'Gesendete Attribute',
	'sf.sp.attrs.standard': 'Standard: Name, E-Mail, Zugehörigkeit und Rolle',
	'sf.sp.attrs.academic': 'Akademisch: Zugehörigkeit und Berechtigung (eduPerson)',
	'sf.sp.attrs.custom': 'Benutzerdefiniert (als Kopie von Standard beginnen)',
	'sf.sp.minAuth.none': 'Keine Anforderung',
	'sf.sp.minAuth.password': 'Passwort',
	'sf.sp.minAuth.aal2': 'Zwei Faktoren (AAL2)',
	'sf.sp.consent': 'Person vor dem Senden von Attributen fragen',
	'sf.sp.testLead':
		'Melden Sie sich als Testbenutzer an und sehen Sie, was der Dienst erhalten würde. Es wird nichts geändert.',
	'sf.sp.check.signed': 'Eine Beispiel-Anmeldeantwort wurde erstellt und signiert',
	'sf.sp.check.answered': 'Die Anmeldeadresse des Dienstes hat geantwortet',
	'sf.sp.certNote': 'Das Zertifikat des Dienstes läuft in {days} Tagen ab.',

	'sf.in.nameHint': 'Wird auf der Anmeldeschaltfläche angezeigt.',
	'sf.in.issuer': 'Aussteller-Adresse',
	'sf.in.issuerHint':
		'Authrim ermittelt alles Weitere aus dem Konfigurationsdokument des Anbieters.',
	'sf.in.readConfig': 'Konfiguration lesen',
	'sf.in.clientIdHint': 'Wird vom Anbieter vergeben, wenn Sie Authrim registrieren.',
	'sf.in.clientSecret': 'Client-Geheimnis',
	'sf.in.attrsLabel': 'Vom Anbieter übernommene Attribute',
	'sf.in.attrsHint.op': 'Welche Claims des Anbieters Teil des Kontos der Person werden.',
	'sf.in.attrsHint.idp': 'Welche Attribute des Anbieters Teil des Kontos der Person werden.',
	'sf.in.attrs.minimal': 'Minimal: nur die Kennung des Anbieters',
	'sf.in.attrs.standard': 'Standard: Name und E-Mail',
	'sf.in.attrs.custom': 'Benutzerdefiniert (als Kopie von Standard beginnen)',
	'sf.in.testLead':
		'Melden Sie sich als Testbenutzer über den Anbieter an und sehen Sie, was Authrim erhält. Es wird kein Konto angelegt.',
	'sf.op.check.config': 'Die Konfiguration wurde gelesen und die Schlüssel wurden abgerufen',
	'sf.op.check.answered': 'Der Anbieter hat die Anmeldeanfrage beantwortet',
	'sf.op.check.token': 'Das ID-Token wurde geprüft und ein Beispielkonto zugeordnet',
	'sf.idp.check.response': 'Die Anmeldeantwort des Anbieters wurde geprüft',
	'sf.idp.check.matched': 'Ein Beispielkonto wurde zugeordnet',
	'sf.idp.certNote': 'Das Zertifikat des Anbieters läuft in {days} Tagen ab.',

	'sf.extra.schemasLead':
		'Welche Attributnamen, Typen und Pflichtfelder auf jeder Seite vorhanden sind.',
	'sf.extra.inputSchema': 'Eingabeschema',
	'sf.extra.outputSchema': 'Ausgabeschema',
	'sf.extra.chooseSchema': 'Schema wählen',
	'sf.extra.noMapping': 'Ohne Schema läuft keine Zuordnung.',
	'sf.extra.setsLead': 'Wie Attribute der Eingabe zu Attributen der Ausgabe werden.',
	'sf.extra.setHint':
		'Ein Satz wird unter Zugriffssteuerung verwaltet und kann von mehreren Verbindungen gemeinsam genutzt werden. Ohne Satz läuft keine Zuordnung.',
	'sf.extra.additionalLead.service':
		'Fragen Sie die Person nach dem, was der Dienst nicht gesendet hat, bevor etwas gespeichert wird.',
	'sf.extra.additionalLead.provider':
		'Fragen Sie die Person nach dem, was der Anbieter nicht gesendet hat, bevor etwas gespeichert wird.',
	'sf.extra.additionalHint': 'Attributnamen. Eine Person wird nur nach fehlenden Angaben gefragt.',
	'sf.extra.addField': 'Feld hinzufügen',
	'sf.extra.statementsLead':
		'Die Texte, die der Person in ihrer Sprache und Version angezeigt werden.',
	'sf.extra.statementsTitle': 'Anzuzeigende Texte',
	'sf.extra.policiesLead': 'Wann die Person gefragt wird und wann erneut.',
	'sf.extra.whenLabel': 'Wann gefragt wird',
	'sf.extra.chooseWhen': 'Zeitpunkt wählen',
	'sf.extra.when.first': 'Nur beim ersten Mal',
	'sf.extra.when.version': 'Beim ersten Mal und erneut, wenn sich ein Text ändert',
	'sf.extra.when.always': 'Bei jeder Anmeldung',
	'sf.extra.roleLead.out':
		'Die Rolle, die die App in Authrim erhält. In der App selbst wird nichts geändert.',
	'sf.extra.roleLead.in':
		'Die Rolle, die ein Authrim-Benutzer erhält, wenn er sich über diesen Anbieter anmeldet.',
	'sf.extra.roleLabel': 'Zuzuweisende Rolle',
	'sf.extra.chooseRole': 'Rolle wählen',
	'sf.extra.role.member': 'Mitglied',
	'sf.extra.role.editor': 'Redakteur',
	'sf.extra.role.admin': 'Administrator',
	'sf.extra.roleNote':
		'Davon zu unterscheiden ist, vorab festzulegen, wem eine Rolle zugewiesen werden darf.',

	'sf.group.signup': 'Registrierung',
	'sf.part.signup-flow': 'Zu verwendender Registrierungsablauf',
	'sf.extra.signupLead.out':
		'Wählen Sie den Registrierungsablauf für Personen, die ohne Konto von dieser App kommen.',
	'sf.extra.signupLead.in':
		'Wählen Sie den Registrierungsablauf für Personen, die sich über diesen Anbieter anmelden und noch kein Konto haben.',
	'sf.extra.signupFlow': 'Registrierungsablauf',
	'sf.extra.chooseSignup': 'Registrierungsablauf wählen',
	'sf.extra.signupHint': 'Registrierungsabläufe werden mit „Serviceablauf hinzufügen“ angelegt.',
	'sf.detail.saveFirst': 'Speichern Sie Ihre Änderungen vor der Aktivierung.',
	'sf.unsaved.title': 'Sie haben ungespeicherte Änderungen',
	'sf.unsaved.body': 'Wenn Sie jetzt zurückgehen, gehen die Änderungen verloren.',
	'sf.unsaved.confirm': 'Verwerfen und zurückgehen',
	'sf.unsaved.keep': 'Weiter bearbeiten',
	'sf.mock.title': 'Serviceabläufe',
	'sf.mock.description': 'Die Serviceabläufe dieses Mandanten.',
	'sf.mock.connections': 'Serviceabläufe',
	'sf.mock.empty': 'Noch keine Serviceabläufe.',
	'sf.mock.col.protocol': 'Protokoll',
	'sf.mock.col.name': 'Name',
	'sf.mock.col.created': 'Erstellt',
	'sf.mock.col.modified': 'Geändert',
	'sf.mock.open': '{name} öffnen',
	'sf.mock.col.kind': 'Art',
	'sf.mock.col.status': 'Status',
	'sf.mock.status.active': 'Aktiv',
	'sf.mock.status.paused': 'Pausiert',
	'sf.mock.status.suspended': 'Gesperrt',
	'sf.maps.in.label': 'Zuordnung der übernommenen Attribute',
	'sf.maps.out.label': 'Zuordnung der weitergegebenen Attribute',
	'sf.maps.in.title': 'Übernahme vom Anbieter',
	'sf.maps.in.description':
		'Macht aus den Attributen, die der Anbieter sendet, die Attribute von Authrim.',
	'sf.maps.out.title': 'Weitergabe an die App',
	'sf.maps.out.description':
		'Bildet aus den Attributen von Authrim die Attribute, die die App erhält.',
	'sf.mock.users.title': 'Alle Benutzer',
	'sf.mock.users.description': 'Beispielseite der Mock-App. Die Daten sind erfunden.',
	'sf.mock.users.card': 'Benutzer',
	'sf.mock.users.email': 'E-Mail',
	// SAML federations (aggregate metadata) as connections
	'sf.part.federation-source': 'Angaben zur Föderation',
	'sf.protocol.federation': 'SAML-Föderation',
	'sf.protocol.federationShort': 'SAML-Föderation',
	'sf.role.fed.badge': 'Föderation',
	'sf.role.fed.line':
		'Alle Anbieter in den Aggregat-Metadaten gelten als vertrauenswürdig. Nur ausgenommene Anbieter sind ausgeschlossen.',
	'sf.name.newFederation': 'Neue Föderation',
	'sf.blurb.federation': 'SAML-Föderation, der über Aggregat-Metadaten beigetreten wird',
	'sf.wizard.kind.federation.label': 'Eine SAML-Föderation',
	'sf.wizard.kind.federation.desc':
		'Vertraut Hunderten Diensten oder Einrichtungen über ein einziges Metadatendokument, ohne Einzelanlage.',
	'sf.metadata.addAsFederation': 'Als Föderation hinzufügen',
	'sf.fed.error.name': 'Geben Sie einen Namen ein.',
	'sf.fed.error.metadataUrl':
		'Die Metadaten-URL muss eine einzelne https-Adresse sein (kein * und keine Leerzeichen).',
	'sf.fed.error.certificates':
		'Fügen Sie mindestens ein Zertifikat hinzu, gegen das die Metadaten-Signatur geprüft wird.',
	'sf.fed.error.roles': 'Aktivieren Sie die SP-Rolle, die IdP-Rolle oder beide.',
	'sf.fed.error.spMapping': 'Wählen Sie das Mapping-Set für die SP-Rolle.',
	'sf.fed.error.idpMapping': 'Wählen Sie das Mapping-Set für die IdP-Rolle.',
	'sf.fed.error.dsUrl': 'Die URL des Discovery Service muss eine https-Adresse sein.',
	'sf.fed.name': 'Name',
	'sf.fed.metadataUrl': 'URL der Aggregat-Metadaten',
	'sf.fed.metadataUrlHint':
		'Die genaue URL, unter der die Föderation ihre Metadaten veröffentlicht. Sie wird regelmäßig neu abgerufen.',
	'sf.fed.description': 'Beschreibung (optional)',
	'sf.fed.trustNote':
		'Nur die hier hinzugefügten Zertifikate prüfen die Signatur der abgerufenen Metadaten. Metadaten mit abweichender Signatur werden nicht importiert.',
	'sf.fed.remaining': 'Noch erforderlich',
	'sf.fed.cert.invalid':
		'Es konnte kein PEM-Zertifikat gelesen werden. Fügen Sie Text ein, der mit „BEGIN CERTIFICATE“ beginnt.',
	'sf.fed.cert.listLabel': 'Signaturzertifikate',
	'sf.fed.cert.fingerprint': 'SHA-256-Fingerabdruck',
	'sf.fed.cert.fingerprintSha1': 'SHA-1-Fingerabdruck',
	'sf.fed.cert.remove': 'Zertifikat entfernen',
	'sf.fed.cert.compare':
		'Vergleichen Sie ihn mit dem von der Föderation veröffentlichten Fingerabdruck. Verwenden Sie kein Zertifikat, das nicht übereinstimmt.',
	'sf.fed.cert.paste': 'Zertifikat (PEM)',
	'sf.fed.cert.pasteHint': 'Einfügen und auf Hinzufügen klicken, um den Fingerabdruck zu sehen.',
	'sf.fed.cert.add': 'Zertifikat hinzufügen',
	'sf.fed.cert.file': 'Zertifikatsdatei wählen',
	'sf.fed.cert.fileHint': 'PEM- und DER-Dateien (binär) werden gelesen.',
	'sf.fed.cert.required':
		'Nötig, um die Signatur der Metadaten zu prüfen. Einfügen, aus einer Datei oder von einer URL hinzufügen.',
	'sf.fed.cert.url': 'Zertifikats-URL',
	'sf.fed.cert.urlHint':
		'Die https-Adresse, unter der das Zertifikat (.cer / .pem) veröffentlicht ist. Beim Lesen werden die Fingerabdrücke angezeigt.',
	'sf.fed.cert.urlRead': 'Von URL lesen',
	'sf.fed.cert.urlReading': 'Wird gelesen…',
	'sf.fed.cert.urlFailed':
		'Das Zertifikat konnte von dieser URL nicht gelesen werden. Prüfen Sie, ob es eine https-Adresse ist, die das Zertifikat selbst liefert.',
	'sf.fed.error.metadataUrlFragment':
		'Die Metadaten-URL darf keinen #-Teil (Link innerhalb einer Seite) enthalten. Geben Sie die Adresse der Metadaten selbst ein.',
	'sf.fed.role.sp': 'SP-Rolle',
	'sf.fed.role.spDesc': 'Die Dienste der Föderation können sich über Authrim anmelden.',
	'sf.fed.role.idp': 'IdP-Rolle',
	'sf.fed.role.idpDesc':
		'Die Personen in Authrim können sich über die Einrichtungen der Föderation anmelden.',
	'sf.fed.mappingSet.sp': 'Mapping-Set (SP-Rolle)',
	'sf.fed.mappingSet.idp': 'Mapping-Set (IdP-Rolle)',
	'sf.fed.mappingSet.failed': 'Die Mapping-Sets konnten nicht geladen werden.',
	'sf.fed.mappingSet.none': 'Es gibt kein auswählbares Mapping-Set. Legen Sie zuerst eines an.',
	'sf.fed.preset.label': 'Standardmäßig gesendete Attribute',
	'sf.fed.preset.hint':
		'Um es für einen Dienst zu ändern, machen Sie ihn zu einer eigenen Verbindung.',
	'sf.fed.preset.basic.v1': 'Basis',
	'sf.fed.preset.enterprise_saas.v1': 'Enterprise-SaaS',
	'sf.fed.preset.academic_publisher.v1': 'Wissenschaftsverlag',
	'sf.fed.preset.research_federation.v1': 'Forschungsföderation',
	'sf.fed.idpSelection.label': 'Wie Personen ihre Einrichtung wählen',
	'sf.fed.idpSelection.authrim': 'Suchseite von Authrim',
	'sf.fed.idpSelection.external': 'Externer Discovery Service',
	'sf.fed.idpSelection.authrimHint':
		'Personen suchen ihre Einrichtung auf der Anmeldeseite über den Namen.',
	'sf.fed.idpSelection.externalHint':
		'Personen wählen ihre Einrichtung im Discovery Service der Föderation.',
	'sf.fed.idpSelection.dsUrl': 'URL des Discovery Service',
	'sf.fed.created.failed': 'Die Metadaten konnten nicht abgerufen werden.',
	'sf.fed.created.failedTitle': 'Der erste Abruf ist fehlgeschlagen',
	'sf.fed.created.fetching': 'Metadaten werden abgerufen und die Signatur wird geprüft …',
	'sf.fed.created.ok': 'Die Metadaten wurden importiert',
	'sf.fed.created.okBody':
		'Die Signatur stimmt mit dem hinzugefügten Zertifikat überein. Die aktivierten Rollen sind jetzt in Gebrauch.',
	'sf.fed.created.unverified': 'Die Signatur konnte nicht geprüft werden',
	'sf.fed.created.unverifiedBody':
		'Prüfen Sie das Zertifikat anhand des veröffentlichten Werts. Bis zur erfolgreichen Prüfung werden Entitäten nicht verwendet.',
	'sf.fed.created.entities': 'Importierte Entitäten',
	'sf.fed.created.signature': 'Signaturprüfung',
	'sf.fed.created.open': 'Föderation öffnen',
	'sf.fed.verification.verified': 'Geprüft',
	'sf.fed.verification.unverified': 'Nicht geprüft',
	'sf.fed.verification.skipped': 'Nicht geprüft (übersprungen)',
	'sf.fed.verification.failed': 'Fehlgeschlagen',
	'sf.fed.status.active': 'In Verwendung',
	'sf.fed.status.draft': 'Nicht gestartet',
	'sf.fed.status.expired': 'Abgelaufen',
	'sf.fed.status.refreshFailed': 'Aktualisierung schlägt fehl',
	'sf.fed.status.retired': 'Außer Betrieb',
	'sf.fed.row.entities': '{count} Entitäten',
	'sf.fed.row.lastFetched': 'zuletzt abgerufen',
	'sf.fed.row.notFetched': 'Noch nicht abgerufen',
	// SAML federation page: status, exceptions, entities, trust
	'sf.fed.statusCard.title': 'Abrufstatus',
	'sf.fed.statusCard.refresh': 'Jetzt aktualisieren',
	'sf.fed.statusCard.expiredTitle': 'Die Metadaten sind abgelaufen',
	'sf.fed.statusCard.expiredBody':
		'Abgelaufene Metadaten können nicht für neue Anmeldungen verwendet werden. Prüfen Sie, ob die Föderation neue Metadaten veröffentlicht hat, und aktualisieren Sie.',
	'sf.fed.statusCard.failedTitle': 'Die letzten Abrufe schlagen fehl',
	'sf.fed.statusCard.failedBody':
		'{count} Abrufe in Folge sind fehlgeschlagen. Die zuvor abgerufenen Metadaten bleiben in Gebrauch.',
	'sf.fed.notInUse.title': 'Diese Föderation wird noch nicht zur Anmeldung genutzt',
	'sf.fed.notInUse.body':
		'Wählen Sie eine Zuordnung und speichern Sie, dann wird sie genutzt. Bis dahin werden nur die Metadaten gesammelt.',
	'sf.fed.created.mappingNeeded':
		'Wählen Sie die Zuordnung bei den Rollen auf der geöffneten Seite. Gibt es keine, legen Sie dort eine an.',
	'sf.fed.statusCard.draft': 'Diese Föderation ist noch nicht in Gebrauch.',
	'sf.fed.statusCard.lastFetched': 'Zuletzt abgerufen',
	'sf.fed.statusCard.validUntil': 'Metadaten gültig bis',
	'sf.fed.statusCard.nextRefresh': 'Nächste Aktualisierung',
	'sf.fed.statusCard.daysAgo': 'vor {count} Tagen abgelaufen',
	'sf.fed.statusCard.daysLeft': 'noch {count} Tage',
	'sf.fed.statusCard.entityCount': '{count} ({excluded} ausgenommen)',
	'sf.fed.history.title': 'Letzte Aktualisierungen',
	'sf.fed.history.manual': 'manuell',
	'sf.fed.history.automatic': 'automatisch',
	'sf.fed.history.running': 'Läuft',
	'sf.fed.history.failed': 'Fehlgeschlagen',
	'sf.fed.history.unchanged': 'Keine Änderung',
	'sf.fed.history.updated': 'Aktualisiert',
	'sf.fed.participation.title': 'Teilnahme',
	'sf.fed.participation.description':
		'Alle Entitäten in den Metadaten der Föderation nehmen teil. Nehmen Sie unerwünschte aus.',
	'sf.fed.advanced': 'Erweitert',
	'sf.fed.ra.label': 'Zulässige Registrierungsstellen',
	'sf.fed.ra.hint':
		'Eine pro Zeile. Wenn gesetzt, nehmen nur von diesen Stellen registrierte Entitäten teil. Leer bedeutet keine Einschränkung.',
	'sf.fed.trust.title': 'Vertrauensgrundlage',
	'sf.fed.trust.description':
		'Woher die Metadaten abgerufen werden und mit welchen Zertifikaten ihre Signatur geprüft wird. Vergleichen Sie die Fingerabdrücke mit den veröffentlichten Werten.',
	'sf.fed.exceptions.title': 'Ausnahmen',
	'sf.fed.exceptions.description':
		'Ausgenommene Entitäten können nicht über diese Föderation teilnehmen. Eine eigene Verbindung bleibt unberührt.',
	'sf.fed.exceptions.label': 'Auszunehmende Entitäten',
	'sf.fed.exceptions.placeholder': 'Nach Name oder Entitäts-ID suchen',
	'sf.fed.exceptions.hint': 'Bis zu {max}. Änderungen gelten nach dem Speichern.',
	'sf.fed.exceptions.none': 'Es ist nichts ausgenommen.',
	'sf.fed.delete.title': 'Föderation löschen',
	'sf.fed.delete.body':
		'Beim Löschen endet jede Teilnahme über diese Föderation. Aus Entitäten erstellte Verbindungen bleiben bestehen.',
	'sf.fed.delete.button': 'Löschen',
	'sf.fed.delete.confirmTitle': '„{name}“ löschen?',
	'sf.fed.delete.confirmBody':
		'Alle Teilnahmen über sie enden. Das kann nicht rückgängig gemacht werden.',
	'sf.fed.delete.confirmWithExplicit':
		'Alle Teilnahmen über sie enden. {count} aus Entitäten erstellte Verbindungen bleiben bestehen. Das kann nicht rückgängig gemacht werden.',
	'sf.fed.delete.failed': 'Die Föderation konnte nicht gelöscht werden.',
	'sf.fed.entities.title': 'Entitäten',
	'sf.fed.entities.description':
		'Die Entitäten in den importierten Metadaten. Suche und Filter laufen auf dem Server.',
	'sf.fed.entities.search': 'Name oder Entitäts-ID',
	'sf.fed.entities.col.name': 'Name',
	'sf.fed.entities.col.entityId': 'Entitäts-ID',
	'sf.fed.entities.col.role': 'Rolle',
	'sf.fed.entities.col.authority': 'Registrierungsstelle',
	'sf.fed.entities.col.validUntil': 'Gültig bis',
	'sf.fed.entities.col.state': 'Status',
	'sf.fed.entities.col.actions': 'Aktionen',
	'sf.fed.entities.role.all': 'Alle Rollen',
	'sf.fed.entities.role.saml_idp': 'IdP',
	'sf.fed.entities.role.saml_sp': 'SP',
	'sf.fed.entities.role.ambiguous': 'IdP / SP',
	'sf.fed.entities.state.all': 'Alle Status',
	'sf.fed.entities.state.participating': 'Nimmt teil',
	'sf.fed.entities.state.excluded': 'Ausgenommen',
	'sf.fed.entities.state.explicit': 'Eigene Verbindung',
	'sf.fed.entities.state.explicitLink': 'Eigene Verbindung',
	'sf.fed.entities.state.policy': 'Außerhalb der Richtlinie',
	'sf.fed.entities.include': 'Wieder aufnehmen',
	'sf.fed.entities.exclude': 'Ausnehmen',
	'sf.fed.entities.materialize': 'Eigene Verbindung anlegen',
	'sf.fed.entities.empty': 'Keine passenden Entitäten.',
	'sf.fed.entities.noLookup':
		'Eigene Verbindungen konnten nicht ermittelt werden und sind daher nicht markiert.',
	'sf.fed.entities.full': 'Es können höchstens 500 Entitäten ausgenommen werden.',
	'sf.fed.entities.failed': 'Die Entitäten konnten nicht geladen werden.',
	'sf.fed.entities.pager': 'Seiten der Entitäten',
	'sf.fed.entities.range': '{from}–{to} von {total}',
	'sf.fed.entities.perPage': 'Pro Seite',
	'sf.fed.entities.previous': 'Zurück',
	'sf.fed.entities.next': 'Weiter',
	'sf.fed.materialize.title': 'Eigene Verbindung anlegen',
	'sf.fed.materialize.submit': 'Verbindung anlegen',
	'sf.fed.materialize.excluded':
		'Diese Entität ist ausgenommen. Mit einer eigenen Verbindung kann sie unabhängig davon genutzt werden.',
	'sf.fed.materialize.type': 'Art der Verbindung',
	'sf.fed.materialize.asSp': 'Als Dienst (SP)',
	'sf.fed.materialize.asIdp': 'Als Anbieter (IdP)',
	'sf.fed.materialize.draft':
		'Die Verbindung wird als Entwurf angelegt. Bis zur Aktivierung wird die Entität wie bisher über die Föderation behandelt; danach hat die Verbindung Vorrang.',
	'sf.fed.materialize.failed': 'Die Verbindung konnte nicht angelegt werden.',
	'sf.fed.saveFailed': 'Speichern fehlgeschlagen. Ihre Eingaben bleiben erhalten.',
	'sf.fed.readonly':
		'Diese Seite ist schreibgeschützt. Für Änderungen ist die Berechtigung zum Bearbeiten der Einstellungen nötig.'
};
