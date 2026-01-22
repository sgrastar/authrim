/**
 * German Translations for Authrim Setup Tool
 * Deutsche Übersetzungen
 */

import type { Translations } from '../types.js';

const de: Translations = {
  // Language selection
  'language.select': 'Select language / 言語を選択 / 选择语言',
  'language.selected': 'Sprache: {{language}}',

  // Banner
  'banner.title': 'Authrim Einrichtung',
  'banner.subtitle': 'OIDC-Anbieter auf Cloudflare Workers',
  'banner.exitHint': 'Drücken Sie jederzeit Strg+C zum Beenden',

  // Mode selection
  'mode.prompt': 'Wählen Sie die Einrichtungsmethode',
  'mode.quick': 'Web-Oberfläche (Empfohlen)',
  'mode.quickDesc': 'Interaktive Einrichtung in Ihrem Browser',
  'mode.advanced': 'CLI-Modus',
  'mode.advancedDesc': 'Interaktive Einrichtung im Terminal',

  // Startup menu
  'startup.description': 'Richten Sie den Authrim OIDC-Anbieter auf Cloudflare Workers ein.',
  'startup.cancel': 'Abbrechen',
  'startup.cancelDesc': 'Einrichtung beenden',
  'startup.cancelled': 'Einrichtung abgebrochen.',
  'startup.resumeLater': 'Um später fortzufahren:',

  // Main menu
  'menu.prompt': 'Was möchten Sie tun?',
  'menu.quick': 'Schnelleinrichtung (5 Minuten)',
  'menu.quickDesc': 'Authrim mit minimaler Konfiguration bereitstellen',
  'menu.custom': 'Benutzerdefinierte Einrichtung',
  'menu.customDesc': 'Alle Optionen Schritt für Schritt konfigurieren',

  // Setup titles
  'quick.title': '⚡ Schnelleinrichtung',
  'custom.title': '🔧 Benutzerdefinierte Einrichtung',
  'menu.manage': 'Vorhandene Umgebungen anzeigen',
  'menu.manageDesc': 'Vorhandene Umgebungen anzeigen, prüfen oder löschen',
  'menu.load': 'Vorhandene Konfiguration laden',
  'menu.loadDesc': 'Einrichtung aus authrim-config.json fortsetzen',
  'menu.exit': 'Beenden',
  'menu.exitDesc': 'Einrichtung beenden',
  'menu.goodbye': 'Auf Wiedersehen!',

  // Update check
  'update.checking': 'Suche nach Updates...',
  'update.available': 'Update verfügbar: {{localVersion}} → {{remoteVersion}}',
  'update.prompt': 'Was möchten Sie tun?',
  'update.continue': 'Mit aktueller Version fortfahren ({{version}})',
  'update.continueDesc': 'Vorhandenen Quellcode verwenden',
  'update.update': 'Auf neueste Version aktualisieren ({{version}})',
  'update.updateDesc': 'Neue Version herunterladen und ersetzen',
  'update.cancel': 'Abbrechen',
  'update.cancelled': 'Abgebrochen.',
  'update.current': 'Verwende Authrim-Quellcode (v{{version}})',

  // Source download
  'source.downloading': 'Lade Quellcode herunter...',
  'source.downloaded': 'Quellcode heruntergeladen ({{version}})',
  'source.extracting': 'Extrahiere Quellcode...',
  'source.installing': 'Installiere Abhängigkeiten (dies kann einige Minuten dauern)...',
  'source.installed': 'Abhängigkeiten installiert',
  'source.installFailed': 'Installation der Abhängigkeiten fehlgeschlagen',
  'source.installManually': 'Sie können versuchen, manuell zu installieren:',
  'source.notInSourceDir': 'Authrim-Quellcode nicht gefunden',
  'source.downloadPrompt': 'Quellcode nach {{path}} herunterladen?',
  'source.downloadOption': 'Quellcode herunterladen',
  'source.downloadOptionDesc': 'Neueste Version herunterladen',
  'source.exitOption': 'Beenden',
  'source.exitOptionDesc': 'Einrichtung beenden',
  'source.cloneManually': 'Zum manuellen Klonen:',
  'source.directoryExists':
    'Verzeichnis {{path}} existiert, ist aber kein gültiger Authrim-Quellcode',
  'source.replaceOption': 'Durch neuen Download ersetzen',
  'source.replaceOptionDesc': '{{path}} entfernen und neueste Version herunterladen',
  'source.differentOption': 'Anderes Verzeichnis verwenden',
  'source.differentOptionDesc': 'Anderen Speicherort angeben',
  'source.enterPath': 'Verzeichnispfad eingeben:',
  'source.updateFailed': 'Aktualisierung fehlgeschlagen',
  'source.downloadFailed': 'Download fehlgeschlagen',
  'source.verificationWarnings': 'Warnungen bei der Quellcode-Strukturprüfung:',

  // WSL Environment
  'wsl.detected': 'WSL-Umgebung erkannt',
  'wsl.cliOnly': 'Web-UI ist unter WSL nicht verfügbar. CLI-Modus wird verwendet.',
  'wsl.explanation': 'Um über den Windows-Browser auf die Web-UI zuzugreifen, muss der Server',
  'wsl.explanationCont': 'an 0.0.0.0 statt an localhost gebunden werden.',
  'wsl.securityNote': 'Sicherheitshinweis:',
  'wsl.securityWarning':
    'Dadurch wird der Server von anderen Geräten in Ihrem Netzwerk erreichbar.',
  'wsl.trustedNetworkOnly': 'Nur in vertrauenswürdigen Netzwerken verwenden.',
  'wsl.bindPrompt': 'An 0.0.0.0 binden für Windows-Zugriff? (y/N):',
  'wsl.bindingToAll': 'Binde an 0.0.0.0',
  'wsl.usingLocalhost': 'Verwende localhost (nur WSL-intern)',

  // Prerequisites
  'prereq.checking': 'Überprüfe Wrangler-Status...',
  'prereq.wranglerNotInstalled': 'Wrangler ist nicht installiert',
  'prereq.wranglerInstallHint': 'Führen Sie folgenden Befehl zur Installation aus:',
  'prereq.notLoggedIn': 'Nicht bei Cloudflare angemeldet',
  'prereq.loginHint': 'Führen Sie folgenden Befehl zur Authentifizierung aus:',
  'prereq.loggedInAs': 'Mit Cloudflare verbunden ({{email}})',
  'prereq.accountId': 'Konto-ID: {{accountId}}',

  // Environment
  'env.prompt': 'Umgebungsnamen eingeben',
  'env.prod': 'Produktion',
  'env.prodDesc': 'Für den Produktiveinsatz',
  'env.staging': 'Staging',
  'env.stagingDesc': 'Für Tests vor der Produktion',
  'env.dev': 'Entwicklung',
  'env.devDesc': 'Für lokale Entwicklung',
  'env.custom': 'Benutzerdefiniert',
  'env.customDesc': 'Benutzerdefinierten Umgebungsnamen eingeben',
  'env.customPrompt': 'Benutzerdefinierten Umgebungsnamen eingeben',
  'env.customValidation':
    'Nur Kleinbuchstaben, Zahlen und Bindestriche erlaubt (z.B. prod, staging, dev)',
  'env.detected': 'Erkannte Umgebungen:',
  'env.selectExisting': 'Vorhandene Umgebung auswählen',
  'env.createNew': 'Neue Umgebung erstellen',
  'env.createNewDesc': 'Eine neue Umgebung einrichten',
  'env.checking': 'Suche nach vorhandenen Umgebungen...',
  'env.alreadyExists': 'Umgebung "{{env}}" existiert bereits',
  'env.existingResources': 'Vorhandene Ressourcen:',
  'env.workers': 'Workers: {{count}}',
  'env.d1Databases': 'D1-Datenbanken: {{count}}',
  'env.kvNamespaces': 'KV-Namespaces: {{count}}',
  'env.chooseAnother':
    'Bitte wählen Sie einen anderen Namen oder verwenden Sie "npx @authrim/setup manage" um sie zuerst zu löschen.',
  'env.available': 'Umgebungsname ist verfügbar',
  'env.checkFailed': 'Vorhandene Umgebungen konnten nicht überprüft werden (fahre trotzdem fort)',
  'env.noEnvFound': 'Keine Authrim-Umgebungen gefunden.',

  // Region
  'region.prompt': 'Region auswählen',
  'region.auto': 'Automatisch (nächstgelegene)',
  'region.autoDesc': 'Cloudflare die nächste Region wählen lassen',
  'region.wnam': 'Nordamerika (West)',
  'region.wnamDesc': 'Westliches Nordamerika',
  'region.enam': 'Nordamerika (Ost)',
  'region.enamDesc': 'Östliches Nordamerika',
  'region.weur': 'Europa (West)',
  'region.weurDesc': 'Westeuropa',
  'region.eeur': 'Europa (Ost)',
  'region.eeurDesc': 'Osteuropa',
  'region.apac': 'Asien-Pazifik',
  'region.apacDesc': 'Asien-Pazifik-Region',
  'region.oceania': 'Ozeanien',
  'region.oceaniaDesc': 'Australien und Pazifikinseln',
  'region.euJurisdiction': 'EU-Gerichtsbarkeit (DSGVO-konform)',
  'region.euJurisdictionDesc': 'Daten werden in der EU gespeichert',

  // UI deployment
  'ui.prompt': 'UI-Bereitstellungsmethode',
  'ui.pagesOption': 'Cloudflare Pages',
  'ui.pagesDesc': 'Auf Cloudflare Pages bereitstellen (empfohlen)',
  'ui.customOption': 'Benutzerdefinierte Domain',
  'ui.customDesc': 'Eigenes Hosting verwenden',
  'ui.skipOption': 'Überspringen',
  'ui.skipDesc': 'UI-Bereitstellung überspringen',
  'ui.customPrompt': 'Benutzerdefinierte UI-URL eingeben',

  // Domain
  'domain.prompt': 'Benutzerdefinierte Domain konfigurieren?',
  'domain.workersDevOption': 'workers.dev-Domain verwenden',
  'domain.workersDevDesc': 'Cloudflare-Standarddomain verwenden',
  'domain.customOption': 'Benutzerdefinierte Domain konfigurieren',
  'domain.customDesc': 'Eigene Domain verwenden',
  'domain.customPrompt': 'Benutzerdefinierte Domain eingeben (z.B. auth.beispiel.de)',
  'domain.customValidation': 'Bitte geben Sie eine gültige Domain ein (z.B. auth.beispiel.de)',
  'domain.issuerUrl': 'Aussteller-URL: {{url}}',
  'domain.apiDomain': 'API-/Aussteller-Domain (z.B. auth.beispiel.de)',
  'domain.loginUiDomain': 'Login-UI-Domain (Enter zum Überspringen)',
  'domain.adminUiDomain': 'Admin-UI-Domain (Enter zum Überspringen)',
  'domain.enterDomains':
    'Benutzerdefinierte Domains eingeben (leer lassen für Cloudflare-Standards)',
  'domain.singleTenantNote': 'Im Single-Tenant-Modus: Aussteller-URL = API-Domain',
  'domain.usingWorkersDev': '(verwendet Cloudflare workers.dev-Domain)',

  // Database
  'db.title': 'Datenbank-Konfiguration',
  'db.regionWarning': 'Die Datenbankregion kann nach der Erstellung nicht mehr geändert werden.',
  'db.coreDescription': 'Core-DB: Speichert OAuth-Clients, Tokens, Sitzungen, Audit-Logs',
  'db.coreRegion': 'Core-Datenbank-Region',
  'db.piiDescription': 'PII-DB: Speichert Benutzerprofile, Anmeldedaten, persönliche Daten',
  'db.piiNote': 'Berücksichtigen Sie Ihre Datenschutzanforderungen.',
  'db.piiRegion': 'PII-Datenbank-Region',
  'db.creating': 'Erstelle Datenbank...',
  'db.created': 'Datenbank erstellt: {{name}}',
  'db.existing': 'Verwende vorhandene Datenbank: {{name}}',
  'db.error': 'Datenbank konnte nicht erstellt werden',
  'db.locationHints': 'Standorthinweise',
  'db.jurisdictionCompliance': 'Gerichtsbarkeit (Compliance)',

  // KV
  'kv.creating': 'Erstelle KV-Namespace...',
  'kv.created': 'KV-Namespace erstellt: {{name}}',
  'kv.existing': 'Verwende vorhandenen KV-Namespace: {{name}}',
  'kv.error': 'KV-Namespace konnte nicht erstellt werden',

  // Queue
  'queue.creating': 'Erstelle Warteschlange...',
  'queue.created': 'Warteschlange erstellt: {{name}}',
  'queue.existing': 'Verwende vorhandene Warteschlange: {{name}}',
  'queue.error': 'Warteschlange konnte nicht erstellt werden',

  // R2
  'r2.creating': 'Erstelle R2-Bucket...',
  'r2.created': 'R2-Bucket erstellt: {{name}}',
  'r2.existing': 'Verwende vorhandenen R2-Bucket: {{name}}',
  'r2.error': 'R2-Bucket konnte nicht erstellt werden',

  // Keys
  'keys.generating': 'Generiere kryptografische Schlüssel...',
  'keys.generated': 'Schlüssel generiert ({{path}})',
  'keys.existing': 'Schlüssel existieren bereits für Umgebung "{{env}}"',
  'keys.existingWarning': 'Vorhandene Schlüssel werden überschrieben.',
  'keys.error': 'Schlüssel konnten nicht generiert werden',
  'keys.regeneratePrompt': 'Schlüssel neu generieren?',
  'keys.regenerateWarning': 'Dies macht alle vorhandenen Tokens ungültig!',

  // Config
  'config.saving': 'Speichere Konfiguration...',
  'config.saved': 'Konfiguration gespeichert in {{path}}',
  'config.error': 'Konfiguration konnte nicht gespeichert werden',
  'config.path': 'Konfigurationspfad',
  'config.summary': 'Konfigurationsübersicht',
  'config.infrastructure': 'Infrastruktur:',
  'config.environment': 'Umgebung:',
  'config.workerPrefix': 'Worker-Präfix:',
  'config.profile': 'Profil:',
  'config.tenantIssuer': 'Tenant & Aussteller:',
  'config.mode': 'Modus:',
  'config.multiTenant': 'Multi-Tenant',
  'config.singleTenant': 'Single-Tenant',
  'config.baseDomain': 'Basis-Domain:',
  'config.issuerFormat': 'Aussteller-Format:',
  'config.issuerUrl': 'Aussteller-URL:',
  'config.defaultTenant': 'Standard-Tenant:',
  'config.displayName': 'Anzeigename:',
  'config.publicUrls': 'Öffentliche URLs:',
  'config.apiRouter': 'API-Router:',
  'config.loginUi': 'Login-UI:',
  'config.adminUi': 'Admin-UI:',
  'config.components': 'Komponenten:',
  'config.featureFlags': 'Feature-Flags:',
  'config.emailSettings': 'E-Mail:',
  'config.oidcSettings': 'OIDC-Einstellungen:',
  'config.accessTtl': 'Access-Token-TTL:',
  'config.refreshTtl': 'Refresh-Token-TTL:',
  'config.authCodeTtl': 'Auth-Code-TTL:',
  'config.pkceRequired': 'PKCE erforderlich:',
  'config.sharding': 'Sharding:',
  'config.authCodeShards': 'Auth-Code:',
  'config.refreshTokenShards': 'Refresh-Token:',
  'config.database': 'Datenbank:',
  'config.coreDb': 'Core-DB:',
  'config.piiDb': 'PII-DB:',
  'config.enabled': 'Aktiviert',
  'config.disabled': 'Deaktiviert',
  'config.standard': '(Standard)',
  'config.notConfigured': 'Nicht konfiguriert (später konfigurieren)',
  'config.yes': 'Ja',
  'config.no': 'Nein',
  'config.shards': 'Shards',
  'config.sec': 'Sek',
  'config.automatic': 'Automatisch',

  // Deploy
  'deploy.prompt': 'Einrichtung mit dieser Konfiguration starten?',
  'deploy.starting': 'Führe Einrichtung aus...',
  'deploy.building': 'Erstelle Pakete...',
  'deploy.deploying': 'Bereitstellung auf Cloudflare...',
  'deploy.success': 'Einrichtung abgeschlossen!',
  'deploy.error': 'Bereitstellung fehlgeschlagen',
  'deploy.skipped': 'Bereitstellung übersprungen',
  'deploy.component': 'Stelle {{component}} bereit...',
  'deploy.uploadingSecrets': 'Lade Geheimnisse hoch...',
  'deploy.secretsUploaded': 'Geheimnisse hochgeladen',
  'deploy.runningMigrations': 'Führe Datenbankmigrationen aus...',
  'deploy.migrationsComplete': 'Migrationen abgeschlossen',
  'deploy.deployingWorker': 'Stelle Worker {{name}} bereit...',
  'deploy.workerDeployed': 'Worker bereitgestellt: {{name}}',
  'deploy.deployingUI': 'Stelle UI bereit...',
  'deploy.uiDeployed': 'UI bereitgestellt',
  'deploy.creatingResources': 'Erstelle Cloudflare-Ressourcen...',
  'deploy.resourcesFailed': 'Ressourcen konnten nicht erstellt werden',
  'deploy.continueWithout':
    'Ohne Bereitstellung fortfahren? (Sie müssen Ressourcen manuell erstellen)',
  'deploy.emailSecretsSaved': 'E-Mail-Geheimnisse gespeichert in {{path}}',
  'deploy.confirmStart': 'Bereitstellung starten?',
  'deploy.confirmDryRun': 'Bereitstellung im Testmodus ausführen?',
  'deploy.cancelled': 'Bereitstellung abgebrochen.',
  'deploy.wranglerChanged': 'Wie möchten Sie mit diesen Änderungen umgehen?',
  'deploy.wranglerKeep': '📝 Manuelle Änderungen behalten (wie vorliegend bereitstellen)',
  'deploy.wranglerBackup': '💾 Sichern und mit Master überschreiben',
  'deploy.wranglerOverwrite': '⚠️ Mit Master überschreiben (Änderungen verlieren)',

  // Email provider
  'email.title': 'E-Mail-Anbieter',
  'email.description': 'E-Mail-Versand für magische Links und Bestätigungscodes konfigurieren.',
  'email.prompt': 'E-Mail-Anbieter jetzt konfigurieren?',
  'email.resendOption': 'Resend',
  'email.resendDesc': 'Moderne E-Mail-API für Entwickler',
  'email.sesOption': 'AWS SES',
  'email.sesDesc': 'Amazon Simple Email Service',
  'email.smtpOption': 'SMTP',
  'email.smtpDesc': 'Generischer SMTP-Server',
  'email.skipOption': 'Keiner (später konfigurieren)',
  'email.skipDesc': 'E-Mail-Konfiguration überspringen',
  'email.apiKeyPrompt': 'Resend API-Schlüssel',
  'email.apiKeyHint': 'Holen Sie Ihren API-Schlüssel unter: https://resend.com/api-keys',
  'email.domainHint': 'Domain einrichten unter: https://resend.com/domains',
  'email.apiKeyRequired': 'API-Schlüssel ist erforderlich',
  'email.apiKeyWarning': 'Warnung: Resend API-Schlüssel beginnen typischerweise mit "re_"',
  'email.fromAddressPrompt': 'Absender-E-Mail-Adresse',
  'email.fromAddressValidation': 'Bitte geben Sie eine gültige E-Mail-Adresse ein',
  'email.fromNamePrompt': 'Absender-Anzeigename (optional)',
  'email.domainVerificationRequired':
    'Domain-Verifizierung erforderlich für Versand von eigener Domain.',
  'email.seeDocumentation': 'Siehe: https://resend.com/docs/dashboard/domains/introduction',
  'email.provider': 'Anbieter:',
  'email.fromAddress': 'Absenderadresse:',
  'email.fromName': 'Absendername:',

  // SMS provider
  'sms.prompt': 'SMS-Anbieter konfigurieren?',
  'sms.twilioOption': 'Twilio',
  'sms.twilioDesc': 'SMS über Twilio',
  'sms.skipOption': 'Keiner (später konfigurieren)',
  'sms.skipDesc': 'SMS-Konfiguration überspringen',
  'sms.accountSidPrompt': 'Twilio Account SID',
  'sms.authTokenPrompt': 'Twilio Auth Token',
  'sms.fromNumberPrompt': 'Absender-Telefonnummer',

  // Social providers
  'social.prompt': 'Social-Login-Anbieter konfigurieren?',
  'social.googleOption': 'Google',
  'social.googleDesc': 'Mit Google anmelden',
  'social.githubOption': 'GitHub',
  'social.githubDesc': 'Mit GitHub anmelden',
  'social.appleOption': 'Apple',
  'social.appleDesc': 'Mit Apple anmelden',
  'social.microsoftOption': 'Microsoft',
  'social.microsoftDesc': 'Mit Microsoft anmelden',
  'social.skipOption': 'Keiner (später konfigurieren)',
  'social.skipDesc': 'Social-Login-Konfiguration überspringen',
  'social.clientIdPrompt': 'Client-ID',
  'social.clientSecretPrompt': 'Client-Secret',

  // Cloudflare API Token
  'cf.apiTokenPrompt': 'Cloudflare API-Token eingeben',
  'cf.apiTokenValidation': 'Bitte geben Sie einen gültigen API-Token ein',

  // OIDC Profile
  'profile.prompt': 'OIDC-Profil auswählen',
  'profile.basicOp': 'Basis-OP (Standard-OIDC-Anbieter)',
  'profile.basicOpDesc': 'Standard-OIDC-Funktionen',
  'profile.fapiRw': 'FAPI Read-Write (Finanzgrad)',
  'profile.fapiRwDesc': 'FAPI 1.0 Read-Write Sicherheitsprofil-kompatibel',
  'profile.fapi2Security': 'FAPI 2.0 Sicherheitsprofil',
  'profile.fapi2SecurityDesc': 'FAPI 2.0 Sicherheitsprofil-kompatibel (höchste Sicherheit)',

  // Tenant configuration
  'tenant.title': 'Tenant-Modus',
  'tenant.multiTenantPrompt':
    'Multi-Tenant-Modus aktivieren? (Subdomain-basierte Tenant-Isolierung)',
  'tenant.multiTenantTitle': 'Multi-Tenant URL-Konfiguration',
  'tenant.multiTenantNote1': 'Im Multi-Tenant-Modus:',
  'tenant.multiTenantNote2': 'Jeder Tenant hat eine Subdomain: https://{tenant}.{basis-domain}',
  'tenant.multiTenantNote3': 'Die Basis-Domain zeigt auf den Router-Worker',
  'tenant.multiTenantNote4': 'Die Aussteller-URL wird dynamisch aus dem Host-Header erstellt',
  'tenant.baseDomainPrompt': 'Basis-Domain (z.B. authrim.com)',
  'tenant.baseDomainRequired': 'Basis-Domain ist für Multi-Tenant-Modus erforderlich',
  'tenant.baseDomainValidation': 'Bitte geben Sie eine gültige Domain ein (z.B. authrim.com)',
  'tenant.issuerFormat': 'Aussteller-URL-Format: https://{tenant}.{{domain}}',
  'tenant.issuerExample': 'Beispiel: https://acme.{{domain}}',
  'tenant.defaultTenantPrompt': 'Standard-Tenant-Name (Bezeichner)',
  'tenant.defaultTenantValidation': 'Nur Kleinbuchstaben, Zahlen und Bindestriche erlaubt',
  'tenant.displayNamePrompt': 'Standard-Tenant-Anzeigename',
  'tenant.singleTenantTitle': 'Single-Tenant URL-Konfiguration',
  'tenant.singleTenantNote1': 'Im Single-Tenant-Modus:',
  'tenant.singleTenantNote2':
    'Aussteller-URL = API-benutzerdefinierte Domain (oder workers.dev als Fallback)',
  'tenant.singleTenantNote3': 'Alle Clients teilen denselben Aussteller',
  'tenant.organizationName': 'Organisationsname (Anzeigename)',
  'tenant.uiDomainTitle': 'UI-Domain-Konfiguration',
  'tenant.customUiDomainPrompt': 'Benutzerdefinierte UI-Domains konfigurieren?',
  'tenant.loginUiDomain': 'Login-UI-Domain (z.B. login.beispiel.de)',
  'tenant.adminUiDomain': 'Admin-UI-Domain (z.B. admin.beispiel.de)',

  // Optional components
  'components.title': 'Optionale Komponenten',
  'components.note': 'Hinweis: Social Login und Policy Engine sind Standardkomponenten',
  'components.samlPrompt': 'SAML-Unterstützung aktivieren?',
  'components.vcPrompt': 'Verifizierbare Credentials aktivieren?',
  'components.saml': 'SAML:',
  'components.vc': 'VC:',
  'components.socialLogin': 'Social Login:',
  'components.policyEngine': 'Policy Engine:',

  // Feature flags
  'features.title': 'Feature-Flags',
  'features.queuePrompt': 'Cloudflare Queues aktivieren? (für Audit-Logs)',
  'features.r2Prompt': 'Cloudflare R2 aktivieren? (für Avatare)',
  'features.queue': 'Warteschlange:',
  'features.r2': 'R2:',

  // OIDC settings
  'oidc.configurePrompt': 'OIDC-Einstellungen konfigurieren? (Token-TTL, etc.)',
  'oidc.title': 'OIDC-Einstellungen',
  'oidc.accessTokenTtl': 'Access-Token-TTL (Sek)',
  'oidc.refreshTokenTtl': 'Refresh-Token-TTL (Sek)',
  'oidc.authCodeTtl': 'Authorization-Code-TTL (Sek)',
  'oidc.pkceRequired': 'PKCE erforderlich?',
  'oidc.positiveInteger': 'Bitte geben Sie eine positive Ganzzahl ein',

  // Sharding settings
  'sharding.configurePrompt': 'Sharding konfigurieren? (für Hochlastumgebungen)',
  'sharding.title': 'Sharding-Einstellungen',
  'sharding.note': 'Hinweis: Zweierpotenz empfohlen für Shard-Anzahl (8, 16, 32, 64, 128)',
  'sharding.authCodeShards': 'Auth-Code-Shard-Anzahl',
  'sharding.refreshTokenShards': 'Refresh-Token-Shard-Anzahl',

  // Infrastructure
  'infra.title': 'Infrastruktur (Automatisch generiert)',
  'infra.workersNote': 'Folgende Workers werden bereitgestellt:',
  'infra.router': 'Router:',
  'infra.auth': 'Auth:',
  'infra.token': 'Token:',
  'infra.management': 'Verwaltung:',
  'infra.otherWorkers': '... und weitere unterstützende Workers',
  'infra.defaultEndpoints': 'Standard-Endpunkte (ohne benutzerdefinierte Domain):',
  'infra.api': 'API:',
  'infra.ui': 'UI:',
  'infra.workersToDeploy': 'Bereitzustellende Workers: {{workers}}',
  'infra.defaultApi': 'Standard-API: {{url}}',

  // Completion
  'complete.title': 'Einrichtung abgeschlossen!',
  'complete.summary': 'Ihr Authrim OIDC-Anbieter wurde bereitgestellt.',
  'complete.issuerUrl': 'Aussteller-URL: {{url}}',
  'complete.adminUrl': 'Admin-Panel: {{url}}',
  'complete.uiUrl': 'Login-UI: {{url}}',
  'complete.nextSteps': 'Nächste Schritte:',
  'complete.nextStep1': '1. Überprüfen Sie die Bereitstellung durch Besuch der Aussteller-URL',
  'complete.nextStep2': '2. Konfigurieren Sie OAuth-Clients im Admin-Panel',
  'complete.nextStep3': '3. Richten Sie bei Bedarf benutzerdefinierte Domains ein',
  'complete.warning': 'Denken Sie daran, Ihre Schlüssel sicher und gesichert aufzubewahren!',
  'complete.success': 'Einrichtung erfolgreich abgeschlossen!',
  'complete.urls': 'URLs:',
  'complete.configLocation': 'Konfiguration:',
  'complete.keysLocation': 'Schlüssel:',

  // Resource provisioning
  'resource.provisioning': 'Stelle {{resource}} bereit...',
  'resource.provisioned': '{{resource}} erfolgreich bereitgestellt',
  'resource.failed': 'Bereitstellung von {{resource}} fehlgeschlagen',
  'resource.skipped': '{{resource}} übersprungen',

  // Manage environments
  'manage.title': 'Vorhandene Umgebungen',
  'manage.loading': 'Lade...',
  'manage.detecting': 'Erkenne Umgebungen...',
  'manage.detected': 'Erkannte Umgebungen:',
  'manage.noEnvs': 'Keine Authrim-Umgebungen gefunden.',
  'manage.selectAction': 'Aktion auswählen',
  'manage.viewDetails': 'Details anzeigen',
  'manage.viewDetailsDesc': 'Detaillierte Ressourceninformationen anzeigen',
  'manage.deleteEnv': 'Umgebung löschen',
  'manage.deleteEnvDesc': 'Umgebung und Ressourcen entfernen',
  'manage.backToMenu': 'Zurück zum Hauptmenü',
  'manage.backToMenuDesc': 'Zum Hauptmenü zurückkehren',
  'manage.selectEnv': 'Umgebung auswählen',
  'manage.back': 'Zurück',
  'manage.continueManaging': 'Umgebungsverwaltung fortsetzen?',

  // Load config
  'loadConfig.title': 'Vorhandene Konfiguration laden',
  'loadConfig.found': '{{count}} Konfiguration(en) gefunden:',
  'loadConfig.new': '(neu)',
  'loadConfig.legacy': '(legacy)',
  'loadConfig.legacyDetected': 'Legacy-Struktur erkannt',
  'loadConfig.legacyFiles': 'Legacy-Dateien:',
  'loadConfig.newBenefits': 'Vorteile der neuen Struktur:',
  'loadConfig.benefit1': 'Umgebungsportabilität (zip .authrim/prod/)',
  'loadConfig.benefit2': 'Versionsverfolgung pro Umgebung',
  'loadConfig.benefit3': 'Sauberere Projektstruktur',
  'loadConfig.migratePrompt': 'Möchten Sie zur neuen Struktur migrieren?',
  'loadConfig.migrateOption': 'Zur neuen Struktur migrieren (.authrim/{env}/)',
  'loadConfig.continueOption': 'Mit Legacy-Struktur fortfahren',
  'loadConfig.migrationComplete': 'Migration erfolgreich abgeschlossen!',
  'loadConfig.validationPassed': 'Validierung bestanden',
  'loadConfig.validationIssues': 'Validierungsprobleme:',
  'loadConfig.newLocation': 'Neuer Konfigurationsspeicherort:',
  'loadConfig.migrationFailed': 'Migration fehlgeschlagen:',
  'loadConfig.continuingLegacy': 'Fahre mit Legacy-Struktur fort...',
  'loadConfig.loadThis': 'Diese Konfiguration laden',
  'loadConfig.specifyOther': 'Andere Datei angeben',
  'loadConfig.noConfigFound': 'Keine Konfiguration im aktuellen Verzeichnis gefunden.',
  'loadConfig.tip': 'Tipp: Sie können eine Konfigurationsdatei angeben mit:',
  'loadConfig.specifyPath': 'Dateipfad angeben',
  'loadConfig.enterPath': 'Konfigurationsdateipfad eingeben',
  'loadConfig.pathRequired': 'Bitte geben Sie einen Pfad ein',
  'loadConfig.fileNotFound': 'Datei nicht gefunden: {{path}}',
  'loadConfig.selectConfig': 'Konfiguration zum Laden auswählen',

  // Common
  'common.yes': 'Ja',
  'common.no': 'Nein',
  'common.continue': 'Weiter',
  'common.cancel': 'Abbrechen',
  'common.skip': 'Überspringen',
  'common.back': 'Zurück',
  'common.confirm': 'Bestätigen',
  'common.error': 'Fehler',
  'common.warning': 'Warnung',
  'common.success': 'Erfolg',
  'common.info': 'Info',
  'common.loading': 'Lade...',
  'common.saving': 'Speichere...',
  'common.processing': 'Verarbeite...',
  'common.done': 'Fertig',
  'common.required': 'Erforderlich',
  'common.optional': 'Optional',

  // Errors
  'error.generic': 'Ein Fehler ist aufgetreten',
  'error.network': 'Netzwerkfehler',
  'error.timeout': 'Zeitüberschreitung',
  'error.invalidInput': 'Ungültige Eingabe',
  'error.fileNotFound': 'Datei nicht gefunden',
  'error.permissionDenied': 'Zugriff verweigert',
  'error.configNotFound': 'Konfiguration nicht gefunden',
  'error.configInvalid': 'Ungültige Konfiguration',
  'error.deployFailed': 'Bereitstellung fehlgeschlagen',
  'error.resourceCreationFailed': 'Ressourcenerstellung fehlgeschlagen',

  // Validation
  'validation.required': 'Dieses Feld ist erforderlich',
  'validation.invalidFormat': 'Ungültiges Format',
  'validation.tooShort': 'Zu kurz',
  'validation.tooLong': 'Zu lang',
  'validation.invalidDomain': 'Ungültige Domain',
  'validation.invalidEmail': 'Ungültige E-Mail-Adresse',
  'validation.invalidUrl': 'Ungültige URL',

  // Delete command
  'delete.title': 'Umgebung löschen',
  'delete.prompt': 'Ressourcen zum Löschen auswählen',
  'delete.confirm': 'Sind Sie sicher, dass Sie "{{env}}" löschen möchten?',
  'delete.confirmPermanent': '⚠️ Dies löscht dauerhaft alle Ressourcen für "{{env}}". Fortfahren?',
  'delete.confirmWarning': 'Diese Aktion kann nicht rückgängig gemacht werden!',
  'delete.deleting': 'Lösche {{resource}}...',
  'delete.deleted': '{{resource}} gelöscht',
  'delete.error': 'Löschen von {{resource}} fehlgeschlagen',
  'delete.cancelled': 'Löschung abgebrochen',
  'delete.noEnvFound': 'Keine Umgebungen gefunden',
  'delete.selectEnv': 'Zu löschende Umgebung auswählen',
  'delete.workers': 'Workers',
  'delete.databases': 'D1-Datenbanken',
  'delete.kvNamespaces': 'KV-Namespaces',
  'delete.queues': 'Warteschlangen',
  'delete.r2Buckets': 'R2-Buckets',

  // Info command
  'info.title': 'Umgebungsinformationen',
  'info.loading': 'Lade Umgebungsinformationen...',
  'info.noResources': 'Keine Ressourcen gefunden',
  'info.environment': 'Umgebung',
  'info.issuer': 'Aussteller',
  'info.workers': 'Workers',
  'info.databases': 'Datenbanken',
  'info.kvNamespaces': 'KV-Namespaces',
  'info.queues': 'Warteschlangen',
  'info.r2Buckets': 'R2-Buckets',
  'info.status': 'Status',
  'info.deployed': 'Bereitgestellt',
  'info.notDeployed': 'Nicht bereitgestellt',

  // Config command
  'configCmd.title': 'Konfiguration',
  'configCmd.showing': 'Zeige Konfiguration',
  'configCmd.validating': 'Validiere Konfiguration...',
  'configCmd.valid': 'Konfiguration ist gültig',
  'configCmd.invalid': 'Konfiguration ist ungültig',
  'configCmd.notFound': 'Konfiguration nicht gefunden',
  'configCmd.error': 'Fehler beim Lesen der Konfiguration',

  // Migrate command
  'migrate.title': 'Zur neuen Struktur migrieren',
  'migrate.checking': 'Überprüfe Migrationsstatus...',
  'migrate.noLegacyFound': 'Keine Legacy-Struktur gefunden',
  'migrate.legacyFound': 'Legacy-Struktur erkannt',
  'migrate.prompt': 'Zur neuen Struktur migrieren?',
  'migrate.migrating': 'Migriere...',
  'migrate.success': 'Migration erfolgreich',
  'migrate.cancelled': 'Migration abgebrochen.',
  'migrate.error': 'Migration fehlgeschlagen',
  'migrate.dryRun': 'Testlauf - keine Änderungen vorgenommen',
  'migrate.backup': 'Erstelle Backup...',
  'migrate.backupCreated': 'Backup erstellt in {{path}}',

  // Security configuration
  'security.title': 'Sicherheitseinstellungen',
  'security.description':
    'Datenschutzeinstellungen konfigurieren. Diese können nach der ersten Datenspeicherung nicht mehr geändert werden.',
  'security.piiEncryption': 'PII-Verschlüsselung',
  'security.piiEncryptionEnabled': 'Anwendungsebene Verschlüsselung (Empfohlen)',
  'security.piiEncryptionEnabledDesc':
    'PII-Daten auf Anwendungsebene verschlüsseln (empfohlen für D1)',
  'security.piiEncryptionDisabled': 'Nur Datenbankebene Verschlüsselung',
  'security.piiEncryptionDisabledDesc':
    'Auf verwaltete DB-Verschlüsselung verlassen (für Aurora, etc.)',
  'security.domainHash': 'E-Mail-Domain-Hashing',
  'security.domainHashEnabled': 'Domain-Hashing aktivieren (Empfohlen)',
  'security.domainHashEnabledDesc': 'E-Mail-Domains für Datenschutz in Analysen hashen',
  'security.domainHashDisabled': 'Domains im Klartext speichern',
  'security.domainHashDisabledDesc': 'E-Mail-Domains ohne Hashing speichern',
  'security.warning':
    '⚠️ Diese Einstellungen können nach der Datenspeicherung nicht mehr geändert werden',

  // Manage command
  'manage.commandTitle': 'Authrim Umgebungsverwaltung',

  // Web UI specific
  'web.title': 'Authrim Einrichtung',
  'web.subtitle': 'OIDC-Anbieter auf Cloudflare Workers',
  'web.loading': 'Lade...',
  'web.error': 'Ein Fehler ist aufgetreten',
  'web.retry': 'Erneut versuchen',
  'web.languageSelector': 'Sprache',
  'web.darkMode': 'Dunkel',
  'web.lightMode': 'Hell',
  'web.systemMode': 'System',

  // Web UI Prerequisites
  'web.prereq.title': 'Voraussetzungen',
  'web.prereq.checking': 'Überprüfe...',
  'web.prereq.checkingRequirements': 'Überprüfe Systemanforderungen...',
  'web.prereq.ready': 'Bereit',
  'web.prereq.wranglerInstalled': 'Wrangler installiert',
  'web.prereq.loggedInAs': 'Angemeldet als {{email}}',

  // Web UI Top Menu
  'web.menu.title': 'Erste Schritte',
  'web.menu.subtitle': 'Wählen Sie eine Option zum Fortfahren:',
  'web.menu.newSetup': 'Neue Einrichtung',
  'web.menu.newSetupDesc': 'Neue Authrim-Bereitstellung von Grund auf erstellen',
  'web.menu.loadConfig': 'Konfiguration laden',
  'web.menu.loadConfigDesc': 'Mit vorhandener Konfiguration fortsetzen oder neu bereitstellen',
  'web.menu.manageEnv': 'Umgebungen verwalten',
  'web.menu.manageEnvDesc': 'Vorhandene Umgebungen anzeigen, prüfen oder löschen',

  // Web UI Setup Mode
  'web.mode.title': 'Einrichtungsmodus',
  'web.mode.subtitle': 'Wählen Sie, wie Sie Authrim einrichten möchten:',
  'web.mode.quick': 'Schnelleinrichtung',
  'web.mode.quickDesc': 'In ~5 Minuten starten',
  'web.mode.quickEnv': 'Umgebungsauswahl',
  'web.mode.quickDomain': 'Optionale benutzerdefinierte Domain',
  'web.mode.quickDefault': 'Standardkomponenten',
  'web.mode.recommended': 'Empfohlen',
  'web.mode.custom': 'Benutzerdefinierte Einrichtung',
  'web.mode.customDesc': 'Volle Kontrolle über die Konfiguration',
  'web.mode.customComp': 'Komponentenauswahl',
  'web.mode.customUrl': 'URL-Konfiguration',
  'web.mode.customAdvanced': 'Erweiterte Einstellungen',

  // Web UI Load Config
  'web.loadConfig.title': 'Konfiguration laden',
  'web.loadConfig.subtitle': 'Wählen Sie Ihre authrim-config.json Datei:',
  'web.loadConfig.chooseFile': 'Datei auswählen',
  'web.loadConfig.preview': 'Konfigurationsvorschau',
  'web.loadConfig.validationFailed': 'Konfigurationsvalidierung fehlgeschlagen',
  'web.loadConfig.valid': 'Konfiguration ist gültig',
  'web.loadConfig.loadContinue': 'Laden und fortfahren',

  // Web UI Configuration
  'web.config.title': 'Konfiguration',
  'web.config.components': 'Komponenten',
  'web.config.apiRequired': 'API (erforderlich)',
  'web.config.apiDesc':
    'OIDC-Anbieter-Endpunkte: authorize, token, userinfo, discovery, Verwaltungs-APIs.',
  'web.config.saml': 'SAML IdP',
  'web.config.deviceFlow': 'Device Flow / CIBA',
  'web.config.vcSdJwt': 'VC SD-JWT',
  'web.config.loginUi': 'Login-UI',
  'web.config.loginUiDesc': 'Vorgefertigte Authentifizierungs-UI auf Cloudflare Pages.',
  'web.config.adminUi': 'Admin-UI',
  'web.config.adminUiDesc': 'Verwaltungs-Dashboard für Benutzer, Clients und Einstellungen.',

  // Web UI URLs
  'web.url.title': 'URL-Konfiguration',
  'web.url.apiDomain': 'API-Domain',
  'web.url.apiDomainHint': 'Leer lassen um workers.dev-Subdomain zu verwenden',
  'web.url.loginDomain': 'Login-UI-Domain',
  'web.url.loginDomainHint': 'Leer lassen um pages.dev-Subdomain zu verwenden',
  'web.url.adminDomain': 'Admin-UI-Domain',
  'web.url.adminDomainHint': 'Leer lassen um pages.dev-Subdomain zu verwenden',

  // Web UI Database
  'web.db.title': 'Datenbank-Konfiguration',
  'web.db.coreTitle': 'Core-Datenbank',
  'web.db.coreSubtitle': '(Nicht-PII)',
  'web.db.coreDesc':
    'Speichert Clients, Autorisierungscodes, Tokens, Sitzungen. Kann global repliziert werden.',
  'web.db.piiTitle': 'PII-Datenbank',
  'web.db.piiSubtitle': '(Personenbezogene Daten)',
  'web.db.piiDesc':
    'Speichert Benutzerprofile, Anmeldedaten, PII. Sollte für Compliance in einer einzigen Gerichtsbarkeit sein.',
  'web.db.name': 'Name',
  'web.db.region': 'Region',
  'web.db.regionAuto': 'Automatisch (nächstgelegene)',

  // Web UI Email
  'web.email.title': 'E-Mail-Anbieter',
  'web.email.subtitle': 'E-Mail-Dienst für Passwort-Reset und Verifizierungs-E-Mails auswählen:',
  'web.email.none': 'Keiner',
  'web.email.noneDesc': 'E-Mail-Funktionen deaktiviert',
  'web.email.resend': 'Resend',
  'web.email.resendDesc': 'Entwicklerfreundliche E-Mail-API',
  'web.email.sendgrid': 'SendGrid',
  'web.email.sendgridDesc': 'Skalierbare E-Mail-Zustellung',
  'web.email.ses': 'Amazon SES',
  'web.email.sesDesc': 'AWS Simple Email Service',
  'web.email.resendConfig': 'Resend-Konfiguration',
  'web.email.apiKey': 'API-Schlüssel',
  'web.email.apiKeyPlaceholder': 're_xxxxxxxx',
  'web.email.fromAddress': 'Absenderadresse',
  'web.email.fromAddressPlaceholder': 'noreply@ihredomain.de',

  // Web UI Provision
  'web.provision.title': 'Cloudflare-Ressourcen erstellen',
  'web.provision.ready': 'Bereit zur Bereitstellung',
  'web.provision.desc': 'Folgende Ressourcen werden in Ihrem Cloudflare-Konto erstellt:',
  'web.provision.createResources': 'Ressourcen erstellen',
  'web.provision.saveConfig': 'Konfiguration speichern',
  'web.provision.continueDeploy': 'Weiter zur Bereitstellung →',

  // Web UI Deploy
  'web.deploy.title': 'Bereitstellen',
  'web.deploy.desc': 'Workers und UI auf Cloudflare bereitstellen:',
  'web.deploy.startDeploy': 'Bereitstellung starten',
  'web.deploy.deploying': 'Bereitstellung läuft...',

  // Web UI Complete
  'web.complete.title': 'Einrichtung abgeschlossen!',
  'web.complete.desc': 'Ihre Authrim-Bereitstellung ist bereit.',
  'web.complete.issuerUrl': 'Aussteller-URL',
  'web.complete.loginUrl': 'Login-URL',
  'web.complete.adminUrl': 'Admin-URL',
  'web.complete.nextSteps': 'Nächste Schritte:',
  'web.complete.step1': 'Schließen Sie die erste Admin-Einrichtung mit der Schaltfläche oben ab',
  'web.complete.step2': 'Konfigurieren Sie Ihren ersten OAuth-Client in der Admin-UI',
  'web.complete.step3': 'Integrieren Sie mit Ihrer Anwendung',
  'web.complete.saveConfig': 'Konfiguration speichern',
  'web.complete.backToMain': 'Zurück zur Startseite',
  'web.complete.canClose': 'Einrichtung abgeschlossen. Sie können dieses Fenster sicher schließen.',

  // Web UI Environment Management
  'web.env.title': 'Umgebungen',
  'web.env.loading': 'Lade Umgebungen...',
  'web.env.noEnvFound': 'Keine Umgebungen gefunden',
  'web.env.refresh': 'Aktualisieren',
  'web.env.adminSetup': 'Admin-Ersteinrichtung',
  'web.env.adminSetupDesc': 'Klicken Sie, um ein Admin-Konto zu erstellen für',
  'web.env.openSetup': 'Einrichtung öffnen',
  'web.env.copyUrl': 'Kopieren',
  'web.env.deleteTitle': 'Umgebung löschen',
  'web.env.deleteWarning':
    'Diese Aktion kann nicht rückgängig gemacht werden. Folgende Ressourcen werden dauerhaft gelöscht:',
  'web.env.confirmDelete': 'Auswahl löschen',
  'web.env.cancel': 'Abbrechen',

  // Web UI Common buttons
  'web.btn.back': 'Zurück',
  'web.btn.continue': 'Weiter',
  'web.btn.cancel': 'Abbrechen',
  'web.btn.save': 'Speichern',
  'web.btn.skip': 'Überspringen',

  // Web UI Save Modal
  'web.modal.saveTitle': 'Konfiguration speichern?',
  'web.modal.saveDesc':
    'Speichern Sie die Konfiguration auf Ihrem lokalen Computer für zukünftige Verwendung.',
  'web.modal.skipSave': 'Überspringen',
  'web.modal.saveConfig': 'Konfiguration speichern',

  // Web UI steps
  'web.step.environment': 'Umgebung',
  'web.step.region': 'Region',
  'web.step.domain': 'Domain',
  'web.step.email': 'E-Mail',
  'web.step.sms': 'SMS',
  'web.step.social': 'Social',
  'web.step.advanced': 'Erweitert',
  'web.step.review': 'Überprüfen',
  'web.step.deploy': 'Bereitstellen',

  // Web UI forms
  'web.form.submit': 'Absenden',
  'web.form.next': 'Weiter',
  'web.form.previous': 'Zurück',
  'web.form.reset': 'Zurücksetzen',
  'web.form.validation': 'Bitte korrigieren Sie die Fehler oben',

  // Web UI progress
  'web.progress.preparing': 'Bereite Bereitstellung vor...',
  'web.progress.creatingResources': 'Erstelle Cloudflare-Ressourcen...',
  'web.progress.generatingKeys': 'Generiere kryptografische Schlüssel...',
  'web.progress.configuringWorkers': 'Konfiguriere Workers...',
  'web.progress.deployingWorkers': 'Stelle Workers bereit...',
  'web.progress.deployingUI': 'Stelle UI bereit...',
  'web.progress.runningMigrations': 'Führe Datenbankmigrationen aus...',
  'web.progress.complete': 'Bereitstellung abgeschlossen!',
  'web.progress.failed': 'Bereitstellung fehlgeschlagen',

  // Web UI Form Labels
  'web.form.envName': 'Umgebungsname',
  'web.form.envNamePlaceholder': 'z.B. prod, staging, dev',
  'web.form.envNameHint': 'Nur Kleinbuchstaben, Zahlen und Bindestriche',
  'web.form.baseDomain': 'Basis-Domain (API-Domain)',
  'web.form.baseDomainPlaceholder': 'oidc.beispiel.de',
  'web.form.baseDomainHint': 'Benutzerdefinierte Domain für Authrim. Leer lassen für workers.dev',
  'web.form.nakedDomain': 'Tenant-Namen aus URL ausschließen',
  'web.form.nakedDomainHint': 'https://beispiel.de statt https://{tenant}.beispiel.de verwenden',
  'web.form.nakedDomainWarning':
    'Tenant-Subdomains erfordern eine benutzerdefinierte Domain. Workers.dev unterstützt keine Wildcard-Subdomains.',
  'web.form.tenantId': 'Standard-Tenant-ID',
  'web.form.tenantIdPlaceholder': 'default',
  'web.form.tenantIdHint': 'Bezeichner des ersten Tenants (Kleinbuchstaben, keine Leerzeichen)',
  'web.form.tenantIdWorkerNote':
    '(Tenant-ID wird intern verwendet. URL-Subdomain erfordert benutzerdefinierte Domain.)',
  'web.form.tenantDisplay': 'Tenant-Anzeigename',
  'web.form.tenantDisplayPlaceholder': 'Meine Firma',
  'web.form.tenantDisplayHint': 'Name auf Login-Seite und Einwilligungsbildschirm',
  'web.form.loginDomainPlaceholder': 'login.beispiel.de',
  'web.form.adminDomainPlaceholder': 'admin.beispiel.de',

  // Web UI Section Headers
  'web.section.apiDomain': 'API-/Aussteller-Domain',
  'web.section.uiDomains': 'UI-Domains (Optional)',
  'web.section.uiDomainsHint':
    'Benutzerdefinierte Domains für Login-/Admin-UIs. Jede kann unabhängig konfiguriert werden. Leer lassen für Cloudflare Pages Standard.',
  'web.section.corsHint':
    'CORS: Cross-Origin-Anfragen von Login-/Admin-UI an API werden automatisch erlaubt.',
  'web.section.configPreview': 'Konfigurationsvorschau',
  'web.section.resourceNames': 'Ressourcennamen',

  // Web UI Preview Labels
  'web.preview.components': 'Komponenten:',
  'web.preview.workers': 'Workers:',
  'web.preview.issuerUrl': 'Aussteller-URL:',
  'web.preview.loginUi': 'Login-UI:',
  'web.preview.adminUi': 'Admin-UI:',

  // Web UI Component Labels
  'web.comp.loginUi': 'Login-UI',
  'web.comp.loginUiDesc':
    'Benutzerorientierte Login-, Registrierungs-, Einwilligungs- und Kontoverwaltungsseiten.',
  'web.comp.adminUi': 'Admin-UI',
  'web.comp.adminUiDesc':
    'Admin-Dashboard zur Verwaltung von Tenants, Clients, Benutzern und Systemeinstellungen.',

  // Web UI Domain Row Labels
  'web.domain.loginUi': 'Login-UI',
  'web.domain.adminUi': 'Admin-UI',

  // Web UI Database Section
  'web.db.introDesc':
    'Authrim verwendet zwei separate D1-Datenbanken, um personenbezogene Daten von Anwendungsdaten zu isolieren.',
  'web.db.regionNote':
    'Hinweis: Die Datenbankregion kann nach der Erstellung nicht mehr geändert werden.',
  'web.db.coreNonPii': 'Nicht-PII',
  'web.db.coreDataDesc': 'Speichert nicht-personenbezogene Anwendungsdaten einschließlich:',
  'web.db.coreData1': 'OAuth-Clients und deren Konfigurationen',
  'web.db.coreData2': 'Autorisierungscodes und Access-Tokens',
  'web.db.coreData3': 'Benutzersitzungen und Anmeldestatus',
  'web.db.coreData4': 'Tenant-Einstellungen und Konfigurationen',
  'web.db.coreData5': 'Audit-Logs und Sicherheitsereignisse',
  'web.db.coreHint':
    'Diese Datenbank verarbeitet alle Authentifizierungsflüsse und sollte nahe Ihrer Hauptbenutzerbasis platziert werden.',
  'web.db.piiLabel': 'Personenbezogene Daten',
  'web.db.piiDataDesc': 'Speichert persönliche Benutzerdaten einschließlich:',
  'web.db.piiData1': 'Benutzerprofile (Name, E-Mail, Telefon)',
  'web.db.piiData2': 'Passkey-/WebAuthn-Anmeldedaten',
  'web.db.piiData3': 'Benutzereinstellungen und Präferenzen',
  'web.db.piiData4': 'Benutzerdefinierte Benutzerattribute',
  'web.db.piiHint':
    'Diese Datenbank enthält personenbezogene Daten. Erwägen Sie die Platzierung in einer Region, die Ihren Datenschutzanforderungen entspricht.',
  'web.db.locationHints': 'Standorthinweise',
  'web.db.jurisdiction': 'Gerichtsbarkeit (Compliance)',
  'web.db.autoNearest': 'Automatisch (nächstgelegene)',
  'web.db.northAmericaWest': 'Nordamerika (West)',
  'web.db.northAmericaEast': 'Nordamerika (Ost)',
  'web.db.europeWest': 'Europa (West)',
  'web.db.europeEast': 'Europa (Ost)',
  'web.db.asiaPacific': 'Asien-Pazifik',
  'web.db.oceania': 'Ozeanien',
  'web.db.euJurisdiction': 'EU-Gerichtsbarkeit (DSGVO-konform)',

  // Web UI Email Section
  'web.email.introDesc':
    'Wird für E-Mail-OTP und E-Mail-Adressverifizierung verwendet. Sie können dies später konfigurieren, wenn Sie möchten.',
  'web.email.configureLater': 'Später konfigurieren',
  'web.email.configureLaterHint': 'Jetzt überspringen und später konfigurieren.',
  'web.email.configureResend': 'Resend konfigurieren',
  'web.email.configureResendHint':
    'E-Mail-Versand mit Resend einrichten (für Produktion empfohlen).',
  'web.email.resendSetup': 'Resend-Konfiguration',
  'web.email.beforeBegin': 'Bevor Sie beginnen:',
  'web.email.step1': 'Erstellen Sie ein Resend-Konto unter',
  'web.email.step2': 'Fügen Sie Ihre Domain hinzu und verifizieren Sie sie unter',
  'web.email.step3': 'Erstellen Sie einen API-Schlüssel unter',
  'web.email.resendApiKey': 'Resend API-Schlüssel',
  'web.email.resendApiKeyHint': 'Ihr API-Schlüssel beginnt mit "re_"',
  'web.email.fromEmailAddress': 'Absender-E-Mail-Adresse',
  'web.email.fromEmailHint': 'Muss von einer verifizierten Domain in Ihrem Resend-Konto sein',
  'web.email.fromDisplayName': 'Absender-Anzeigename (optional)',
  'web.email.fromDisplayHint': 'Wird als Absendername in E-Mail-Clients angezeigt',
  'web.email.domainVerificationTitle': 'Domain-Verifizierung erforderlich',
  'web.email.domainVerificationDesc':
    'Bevor Ihre Domain verifiziert ist, können E-Mails nur von onboarding@resend.dev gesendet werden (zum Testen).',
  'web.email.learnMore': 'Mehr über Domain-Verifizierung erfahren →',

  // Web UI Provision Section
  'web.provision.resourcePreview': 'Ressourcennamen:',
  'web.provision.d1Databases': 'D1-Datenbanken:',
  'web.provision.kvNamespaces': 'KV-Namespaces:',
  'web.provision.cryptoKeys': 'Kryptografische Schlüssel:',
  'web.provision.initializing': 'Initialisiere...',
  'web.provision.showLog': 'Detailliertes Log anzeigen',
  'web.provision.hideLog': 'Detailliertes Log ausblenden',
  'web.provision.keysSavedTo': 'Schlüssel gespeichert in:',
  'web.provision.keepSafe':
    'Bewahren Sie dieses Verzeichnis sicher auf und fügen Sie es zu .gitignore hinzu',

  // Web UI Deploy Section
  'web.deploy.readyText': 'Bereit, Authrim-Workers auf Cloudflare bereitzustellen.',

  // Web UI Environment List
  'web.env.detectedDesc': 'Erkannte Authrim-Umgebungen in Ihrem Cloudflare-Konto:',
  'web.env.noEnvsDetected': 'Keine Authrim-Umgebungen in diesem Cloudflare-Konto erkannt.',
  'web.env.backToList': '← Zurück zur Liste',
  'web.env.deleteEnv': 'Umgebung löschen...',

  // Web UI Environment Detail
  'web.envDetail.title': 'Umgebungsdetails',
  'web.envDetail.adminNotConfigured': 'Admin-Konto nicht konfiguriert',
  'web.envDetail.adminNotConfiguredDesc':
    'Der erste Administrator wurde für diese Umgebung noch nicht eingerichtet.',
  'web.envDetail.startPasskey': 'Admin-Konto-Einrichtung mit Passkey starten',
  'web.envDetail.setupUrlGenerated': 'Einrichtungs-URL generiert:',
  'web.envDetail.copyBtn': 'Kopieren',
  'web.envDetail.openSetup': 'Einrichtung öffnen',
  'web.envDetail.urlValidFor':
    'Diese URL ist 1 Stunde gültig. Öffnen Sie sie in einem Browser, um das erste Admin-Konto zu registrieren.',
  'web.envDetail.workers': 'Workers',
  'web.envDetail.d1Databases': 'D1-Datenbanken',
  'web.envDetail.kvNamespaces': 'KV-Namespaces',
  'web.envDetail.queues': 'Warteschlangen',
  'web.envDetail.r2Buckets': 'R2-Buckets',
  'web.envDetail.pagesProjects': 'Pages-Projekte',

  // Web UI Worker Update Section
  'web.envDetail.workerUpdate': 'Workers aktualisieren',
  'web.envDetail.workerName': 'Worker',
  'web.envDetail.deployedVersion': 'Bereitgestellt',
  'web.envDetail.localVersion': 'Lokal',
  'web.envDetail.updateStatus': 'Status',
  'web.envDetail.needsUpdate': 'Aktualisieren',
  'web.envDetail.upToDate': 'Aktuell',
  'web.envDetail.notDeployed': 'Nicht bereitgestellt',
  'web.envDetail.updateOnlyChanged': 'Nur geänderte Versionen aktualisieren',
  'web.envDetail.updateAllWorkers': 'Workers aktualisieren',
  'web.envDetail.refreshVersions': 'Aktualisieren',
  'web.envDetail.updateProgress': 'Aktualisierungsfortschritt:',
  'web.envDetail.updatesAvailable': '{{count}} Update(s) verfügbar',
  'web.envDetail.allUpToDate': 'Alles aktuell',

  // Web UI Delete Section
  'web.delete.title': 'Umgebung löschen',
  'web.delete.warning':
    'Diese Aktion ist unwiderruflich. Alle ausgewählten Ressourcen werden dauerhaft gelöscht.',
  'web.delete.environment': 'Umgebung:',
  'web.delete.selectResources': 'Zu löschende Ressourcen auswählen:',
  'web.delete.workers': 'Workers',
  'web.delete.d1Databases': 'D1-Datenbanken',
  'web.delete.kvNamespaces': 'KV-Namespaces',
  'web.delete.queues': 'Warteschlangen',
  'web.delete.r2Buckets': 'R2-Buckets',
  'web.delete.pagesProjects': 'Pages-Projekte',
  'web.delete.cancelBtn': 'Abbrechen',
  'web.delete.confirmBtn': 'Auswahl löschen',

  // Web UI Save Modal
  'web.modal.saveQuestion':
    'Möchten Sie Ihre Konfiguration vor dem Fortfahren in einer Datei speichern?',
  'web.modal.saveReason':
    'Dies ermöglicht es Ihnen, die Einrichtung später fortzusetzen oder dieselben Einstellungen für eine andere Bereitstellung zu verwenden.',
  'web.modal.skipBtn': 'Überspringen',
  'web.modal.saveBtn': 'Konfiguration speichern',

  // Web UI Error Messages
  'web.error.wranglerNotInstalled': 'Wrangler nicht installiert',
  'web.error.pleaseInstall': 'Bitte installieren Sie zuerst Wrangler:',
  'web.error.notLoggedIn': 'Nicht bei Cloudflare angemeldet',
  'web.error.runCommand': 'Bitte führen Sie diesen Befehl in Ihrem Terminal aus:',
  'web.error.thenRefresh': 'Aktualisieren Sie dann diese Seite.',
  'web.error.checkingPrereq': 'Fehler beim Überprüfen der Voraussetzungen:',
  'web.error.invalidJson': 'Ungültiges JSON:',
  'web.error.validationFailed': 'Validierungsanfrage fehlgeschlagen:',

  // Web UI Status Messages
  'web.status.checking': 'Überprüfe...',
  'web.status.running': 'Wird ausgeführt...',
  'web.status.deploying': 'Bereitstellung...',
  'web.status.complete': 'Abgeschlossen',
  'web.status.error': 'Fehler',
  'web.status.scanning': 'Scanne...',
  'web.status.saving': 'Speichere...',
  'web.status.notDeployed': '(Nicht bereitgestellt)',
  'web.status.startingDeploy': 'Starte Bereitstellung...',
  'web.status.none': 'Keine',
  'web.status.loading': 'Lade...',
  'web.status.failedToLoad': 'Laden fehlgeschlagen',
  'web.status.adminNotConfigured': 'Admin nicht konfiguriert',
  'web.status.initializing': 'Initialisiere...',
  'web.status.found': '{{count}} gefunden',

  // Web UI Button Labels (dynamic)
  'web.btn.reprovision': 'Neu bereitstellen (Löschen & Erstellen)',
  'web.btn.createResources': 'Ressourcen erstellen',
  'web.btn.saveConfiguration': 'Konfiguration speichern',

  // Quick setup specific
  'quickSetup.title': 'Schnelleinrichtung',

  // Custom setup specific
  'customSetup.title': 'Benutzerdefinierte Einrichtung',
  'customSetup.cancelled': 'Einrichtung abgebrochen.',

  // Web UI starting
  'webUi.starting': 'Starte Web-Oberfläche...',
};

export default de;
