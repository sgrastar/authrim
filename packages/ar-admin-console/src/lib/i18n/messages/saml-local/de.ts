import type { jaSamlLocal } from './ja';

export const deSamlLocal: Record<keyof typeof jaSamlLocal, string> = {
	'sl.identity.title': 'SAML dieses Mandanten',
	'sl.identity.desc':
		'Was Authrim bei Partnern als IdP und als SP registriert. Laden Sie die Metadaten-XML herunter und übergeben Sie sie, oder nennen Sie die Metadaten-URL.',
	'sl.role.idp': 'IdP',
	'sl.role.sp': 'SP',
	'sl.role.idp.title': 'Authrim als IdP registrieren',
	'sl.role.sp.title': 'Authrim als SP registrieren',
	'sl.role.idp.hint': 'Für einen externen Dienst (SP), der Personen über Authrim anmeldet.',
	'sl.role.sp.hint': 'Für einen externen IdP, an den Authrim Personen weiterleitet.',
	'sl.entityId': 'Entity-ID',
	'sl.metadataUrl': 'Metadaten-URL',
	'sl.openMetadata': 'Metadaten-XML öffnen',
	'sl.copy': '{name} kopieren',
	'sl.notDeployed': 'SAML ist in dieser Umgebung nicht bereitgestellt',

	'sl.certs.title': 'Signaturzertifikate ({role})',
	'sl.certs.desc':
		'Die in den Metadaten veröffentlichten Zertifikate. Ein Wechsel ist „Nächstes Zertifikat ausstellen“ und, sobald die Partner es haben, „Auf das nächste Zertifikat umschalten“.',
	'sl.slot.active': 'In Gebrauch',
	'sl.slot.next': 'Nächstes',
	'sl.slot.nextN': 'Nächstes {index}',
	'sl.slot.backup': 'Sicherung',
	'sl.slot.active.desc': 'Signiert jetzt und ist in den Metadaten veröffentlicht.',
	'sl.slot.next.desc': 'Wartet auf den Wechsel.',
	'sl.slot.backup.desc':
		'Das bis zum letzten Wechsel verwendete Zertifikat; ausmustern, sobald die Partner umgestellt haben.',
	'sl.slot.published': 'In den Metadaten',
	'sl.slot.scheduled': 'In den Metadaten ab {date}',
	'sl.slot.withheld': 'Nicht in den Metadaten',
	'sl.slot.withheld.hint':
		'Der Veröffentlichungsmodus der Rolle (metadataCertificatePublication) lässt diesen Platz aus.',
	'sl.slot.defaultKey': 'Signiert mit dem Standardschlüssel der Umgebung',
	'sl.slot.empty': 'Keines',
	'sl.cert.subject': 'Inhaber',
	'sl.cert.issuer': 'Aussteller',
	'sl.cert.validFrom': 'Gültig ab',
	'sl.cert.validTo': 'Gültig bis',
	'sl.cert.signature': 'Signaturalgorithmus',
	'sl.cert.publicKey': 'Öffentlicher Schlüssel',
	'sl.cert.sha1': 'SHA-1-Fingerabdruck',
	'sl.cert.sha256': 'SHA-256-Fingerabdruck',
	'sl.cert.kid': 'Schlüssel-ID',
	'sl.cert.pem': 'Zertifikat (PEM)',
	'sl.cert.copyPem': 'PEM kopieren',
	'sl.cert.downloadPem': 'PEM herunterladen',
	'sl.cert.expired': 'Abgelaufen',
	'sl.cert.daysLeft': 'Noch {days} Tage',
	'sl.cert.previewFailed': 'Das Zertifikat konnte nicht gelesen werden.',
	'sl.cert.show': 'Zertifikat anzeigen',
	'sl.cert.detail.title': 'Zertifikat {role} ({slot})',

	'sl.action.publishNext': 'Nächstes Zertifikat ausstellen',
	'sl.action.promoteNext': 'Auf das nächste Zertifikat umschalten',
	'sl.action.promoteNext.confirm.title': 'Signatur ({role}) auf das nächste Zertifikat umschalten?',
	'sl.action.promoteNext.confirm.body':
		'Ab jetzt signiert das nächste Zertifikat; das bisherige bleibt als Sicherung in den Metadaten. Stellen Sie sicher, dass die Partner das nächste Zertifikat bereits importiert haben.',
	'sl.action.retireBackup': 'Sicherung ausmustern',
	'sl.action.retireBackup.confirm.title': 'Sicherungszertifikat ({role}) ausmustern?',
	'sl.action.retireBackup.confirm.body':
		'Es verlässt die Metadaten. Ein Partner, der noch damit prüft, scheitert.',
	'sl.action.deleteNext': 'Nächstes Zertifikat löschen',
	'sl.action.deleteNext.confirm.title': 'Nächstes Zertifikat ({role}) löschen?',
	'sl.action.deleteNext.confirm.body':
		'Es wird aus den Metadaten und aus dem Wechsel zurückgezogen. Das Schlüsselmaterial selbst wird nicht vernichtet. Es wird nichts umgeschaltet.',
	'sl.action.recreateActive': 'Aktiven Schlüssel ({role}) jetzt neu erzeugen',
	'sl.action.recreateActive.confirm.title': 'Aktiven Schlüssel ({role}) neu erzeugen?',
	'sl.action.recreateActive.confirm.body':
		'Ein Notfallvorgang: Die Signatur wechselt sofort auf einen neuen Schlüssel, daher scheitert SAML mit jedem Partner, bis er die Metadaten erneut importiert. Für einen geplanten Wechsel „Nächstes Zertifikat ausstellen“ verwenden.',
	'sl.emergency.title': 'Notfall',
	'sl.emergency.desc':
		'Wenn ein Wechsel nicht warten kann, etwa bei einem kompromittierten Schlüssel.',
	'sl.action.done': 'Die Signaturzertifikate wurden aktualisiert.',

	'sl.new.title': 'Nächstes Zertifikat ({role}) ausstellen',
	'sl.new.desc':
		'Erzeugt einen neuen Schlüssel mit selbstsigniertem Zertifikat und veröffentlicht es in den Metadaten als nächstes. Die Signatur wechselt noch nicht.',
	'sl.new.useCurrent': 'Inhaber des aktuellen Zertifikats übernehmen',
	'sl.new.country': 'Land (C)',
	'sl.new.state': 'Bundesland (ST)',
	'sl.new.locality': 'Ort (L)',
	'sl.new.organization': 'Organisation (O)',
	'sl.new.unit': 'Organisationseinheit (OU)',
	'sl.new.commonName': 'Allgemeiner Name (CN)',
	'sl.new.validFrom': 'Gültig ab',
	'sl.new.validTo': 'Gültig bis',
	'sl.new.validity.hint': 'Leer: ein Jahr ab jetzt.',
	'sl.new.keySize': 'Schlüssellänge (RSA)',
	'sl.new.san': 'DNS-Namen der SAML-Adressen des Mandanten aufnehmen',
	'sl.new.san.desc': 'Diese Namen kommen in den Subject Alternative Name des Zertifikats.',
	'sl.new.san.none': '(keine)',
	'sl.new.san.extra': 'Weitere DNS-Namen',
	'sl.new.san.extra.hint': 'Durch Kommas oder Leerzeichen getrennt.',
	'sl.new.submit': 'Ausstellen und veröffentlichen',
	'sl.new.validity.error': 'Das Ende muss nach dem Beginn liegen.',

	'sl.pub.title': 'Veröffentlichte Entity-IDs und Anmeldeadresse',
	'sl.pub.desc':
		'Die Form der Entity-IDs, die Partner registrieren, und wo eine interaktive SAML-Anmeldung beginnt. Änderungen erfordern auch Änderungen bei den Partnern.',
	'sl.pub.style': 'Form der Entity-ID',
	'sl.pub.style.metadataUrl': 'Metadaten-URL',
	'sl.pub.style.metadataUrl.desc': 'Die Metadaten-URL selbst ist die Entity-ID (Standard).',
	'sl.pub.style.roleUrl': 'Rollen-URL',
	'sl.pub.style.roleUrl.desc': 'Die IdP- bzw. SP-URL ohne das abschließende /metadata.',
	'sl.pub.current': 'Jetzt',
	'sl.pub.afterSave': 'Nach dem Speichern',
	'sl.pub.idpEntityId': 'Entity-ID des IdP',
	'sl.pub.spEntityId': 'Entity-ID des SP',
	'sl.pub.login': 'Interaktive Anmeldung geht an',
	'sl.pub.login.tenantHost': 'Den Host des Mandanten',
	'sl.pub.login.tenantHost.desc': 'Öffnet die Anmeldeseite unter der Adresse dieses Mandanten.',
	'sl.pub.login.uiBaseUrl': 'Die gemeinsame Anmelde-UI',
	'sl.pub.login.uiBaseUrl.desc':
		'Öffnet die gemeinsame Anmelde-UI der Umgebung, die den Mandanten ermittelt.',
	'sl.pub.metadata.title': 'Veröffentlichung der Metadaten',
	'sl.pub.metadata.signing': 'Metadaten-Signatur',
	'sl.pub.metadata.signing.on': 'Signiert',
	'sl.pub.metadata.signing.off': 'Nicht signiert',
	'sl.pub.metadata.validUntil': 'validUntil',
	'sl.pub.metadata.validUntil.off': 'Nicht gesetzt',
	'sl.pub.metadata.validityDays': '{days} Tage',
	'sl.pub.metadata.cacheDuration': 'Cache-Dauer',
	'sl.pub.metadata.hint':
		'Einstellungen der Umgebung. validUntil und die Cache-Dauer setzen voraus, dass Partner die Metadaten regelmäßig neu abrufen.',
	'sl.pub.warning':
		'Eine Änderung der Entity-ID oder der Anmeldeadresse weicht von dem ab, was Partner registriert haben. Bitten Sie die Partner danach, die Metadaten neu abzurufen.',
	'sl.pub.save': 'Speichern',
	'sl.pub.saved': 'Die Veröffentlichungseinstellungen wurden gespeichert.',

	'sl.dr.title': 'DR-Bündel der Signaturschlüssel',
	'sl.dr.desc':
		'Exportiert die Signaturschlüssel von IdP und SP (einschließlich privater Schlüssel) mit einer Passphrase verschlüsselt, um sie in eine andere Umgebung oder nach einem Neuaufbau in diesen Mandanten zu importieren. Die bei Partnern registrierten Zertifikate bleiben dabei erhalten.',
	'sl.dr.sensitive': 'Vertraulich',
	'sl.dr.warning':
		'Das Bündel enthält private Schlüssel. Offline aufbewahren und nur in den vorgesehenen Mandanten importieren. Eine vollständige Mandantensicherung enthält dieselben Schlüssel.',
	'sl.dr.passphrase': 'Passphrase',
	'sl.dr.passphrase.hint':
		'Mindestens {min} Zeichen. Der Import des Bündels braucht dieselbe Passphrase.',
	'sl.dr.passphrase.confirm': 'Passphrase (Wiederholung)',
	'sl.dr.passphrase.short': 'Mindestens {min} Zeichen verwenden.',
	'sl.dr.passphrase.mismatch': 'Die Passphrasen stimmen nicht überein.',
	'sl.dr.export': 'Bündel exportieren',
	'sl.dr.exported': 'Das DR-Bündel wurde heruntergeladen.',
	'sl.dr.import.title': 'Bündel importieren',
	'sl.dr.import.desc':
		'Wählen Sie die exportierte JSON-Datei und geben Sie die Passphrase an, mit der sie erstellt wurde. Der Import ersetzt die Signaturschlüssel beider Rollen und setzt auch die Form der Entity-ID und die Adresse der interaktiven Anmeldung auf den Stand zur Zeit des Exports zurück.',
	'sl.dr.import.file': 'DR-Bündel (JSON)',
	'sl.dr.import': 'Importieren',
	'sl.dr.import.confirm.title': 'DR-Bündel importieren?',
	'sl.dr.import.confirm.body':
		'Die Signaturschlüssel dieses Mandanten werden durch die des Bündels ersetzt, und die Form der Entity-ID sowie die Adresse der interaktiven Anmeldung kehren auf den Stand zur Zeit des Exports zurück. Ein Bündel, dessen Zertifikate oder Entity-IDs von den bei Partnern registrierten abweichen, unterbricht SAML mit ihnen.',
	'sl.dr.import.notJson': 'Die Datei konnte nicht als JSON gelesen werden.',
	'sl.dr.imported': 'Das DR-Bündel wurde importiert. Die Signaturschlüssel wurden ersetzt.',
	'sl.dr.forbidden':
		'Das DR-Bündel erfordert die Berechtigungen zum Export und Import der SAML-Signaturschlüssel.',

	'sl.load.failed': 'Die SAML-Einstellungen konnten nicht geladen werden.',
	'sl.forbidden': 'Sie dürfen die SAML-Einstellungen nicht sehen.',
	'sl.readOnly':
		'Nur Ansicht. Änderungen erfordern die Berechtigung zum Aktualisieren von SAML-Anbietern.',
	'sl.cancelled': 'Der Vorgang wurde abgebrochen.'
};
