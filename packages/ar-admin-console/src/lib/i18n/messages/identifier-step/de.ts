import type { jaIdentifierStep } from './ja';

export const deIdentifierStep: Record<keyof typeof jaIdentifierStep, string> = {
	'map.t.persistent_identifier': 'Persistente Kennung erzeugen',
	'map.d.persistent_identifier':
		'Erzeugt eine persistente Kennung aus der Konto-ID (oder einem importierten Wert). Ein Quellattribut wird nicht verwendet.',
	'map.x.pid.source': 'Schritt {n}: Wählen Sie die Kennungsquelle.',
	'map.x.pid.store': 'Schritt {n}: Wählen Sie den Speicher für Kennungen oder „Nicht verwenden“.',
	'map.x.pid.scope': 'Schritt {n}: Geben Sie den Scope ein (Buchstaben, Ziffern, „.“ und „-“).',
	'map.x.pid.formatAlgorithm':
		'Schritt {n}: Dieser Algorithmus kann das gewählte Format nicht erzeugen.',
	'map.x.pid.salt': 'Schritt {n}: Der Name des Salts ist ungültig.',
	'map.x.pid.exceptions': 'Schritt {n}: Der Name der Ausnahmenliste ist ungültig.',
	'map.x.pid.other': 'Schritt {n}: Prüfen Sie die Einstellungen der persistenten Kennung.',
	'map.x.pid.withSource':
		'Schritt {n}: Dieser Schritt verwendet kein Quellattribut. Entfernen Sie die Quellattribute.',

	'pid.p.input': 'Erzeugt aus',
	'pid.p.source': 'Kennungsquelle',
	'pid.p.format': 'Format',
	'pid.p.algorithm': 'Algorithmus',
	'pid.p.digest': 'Digest',
	'pid.p.encoding': 'Kodierung',
	'pid.p.audience': 'Kennung pro',
	'pid.p.scope': 'Scope',
	'pid.p.salt': 'Salt',
	'pid.p.stored': 'Gespeicherte Kennungen',
	'pid.p.store': 'Speicher',
	'pid.p.exceptions': 'Ausnahmenliste',

	'pid.o.input.account': 'Konto-ID',
	'pid.o.input.source': 'Importierter Wert',
	'pid.o.format.plain': 'Einfach',
	'pid.o.format.saml_targeted_id': 'SAML eduPersonTargetedID',
	'pid.o.format.saml_pairwise_id': 'SAML pairwise-id',
	'pid.o.format.saml_subject_id': 'SAML subject-id',
	'pid.o.algorithm.authrim_sha256': 'Authrim (SHA-256)',
	'pid.o.algorithm.shibboleth': 'Shibboleth',
	'pid.o.algorithm.keycloak_sha256': 'Keycloak (SHA-256)',
	'pid.o.algorithm.simplesamlphp_targeted_id': 'SimpleSAMLphp (targeted ID)',
	'pid.o.algorithm.simplesamlphp_persistent_nameid': 'SimpleSAMLphp (persistent NameID)',
	'pid.o.algorithm.simplesamlphp_pairwise_id': 'SimpleSAMLphp (pairwise ID)',
	'pid.o.algorithm.simplesamlphp_subject_id': 'SimpleSAMLphp (subject ID)',
	'pid.o.digest.SHA-1': 'SHA-1',
	'pid.o.digest.SHA-256': 'SHA-256',
	'pid.o.digest.SHA-384': 'SHA-384',
	'pid.o.digest.SHA-512': 'SHA-512',
	'pid.o.encoding.base64': 'Base64',
	'pid.o.encoding.base32': 'Base32',
	'pid.o.audience.auto': 'Automatisch (pro App oder SP)',
	'pid.o.audience.sector': 'Sector-ID',
	'pid.o.audience.sp_entity_id': 'Entity-ID des SP',
	'pid.o.stored.off': 'Nicht verwenden',
	'pid.o.stored.prefer': 'Verwenden, falls vorhanden',
	'pid.o.stored.require': 'Immer verwenden',

	'pid.choose': 'Auswählen',
	'pid.none': 'Keine',
	'pid.optionCount': '{name} ({count})',
	'pid.optionSalt': '{name} (Fingerabdruck {fingerprint})',
	'pid.loading': 'Wird geladen…',
	'pid.loadFailed': 'Die Liste konnte nicht geladen werden. Bitte versuchen Sie es erneut.',
	'pid.retry': 'Erneut laden',
	'pid.importCsv': 'CSV importieren',
	'pid.importSalt': 'Salt importieren',
	'pid.hint.scope': 'Zum Beispiel: example.edu',
	'pid.hint.salt': 'Bleibt das Feld leer, wird das Standard-Salt verwendet.',
	'pid.nameHint': 'Kleinbuchstaben, Ziffern, „-“ und „_“, höchstens 63 Zeichen.',
	'pid.error.forbidden': 'Sie haben keine Berechtigung für diese Aktion.',
	'pid.error.name': 'Geben Sie einen Namen ein.',

	'pid.result.salt.created': 'Das Salt „{name}“ wurde importiert (Fingerabdruck {fingerprint}).',
	'pid.result.salt.unchanged':
		'Das Salt „{name}“ ist bereits mit demselben Inhalt gespeichert. Nichts wurde geändert.',
	'pid.result.salt.replaced': 'Das Salt „{name}“ wurde ersetzt (Fingerabdruck {fingerprint}).',
	'pid.result.pairs':
		'In „{name}“ importiert: {created} neu, {replaced} ersetzt, {unchanged} unverändert.',
	'pid.result.exceptions':
		'Die Ausnahmenliste „{name}“ wurde ersetzt ({rows} Einträge: {salts} mit Salt, {blocks} gesperrt).',
	'pid.result.exceptionsEmptied': 'Die Ausnahmenliste „{name}“ wurde geleert.',

	'pid.salt.title': 'Salt importieren',
	'pid.salt.name': 'Name',
	'pid.salt.value': 'Salt',
	'pid.salt.encoding': 'Eingabe als',
	'pid.salt.enc.utf8': 'Text (UTF-8)',
	'pid.salt.enc.base64': 'Base64',
	'pid.salt.submit': 'Importieren',
	'pid.salt.error.value': 'Geben Sie das Salt ein.',
	'pid.salt.error.invalid': 'Das Salt konnte nicht gelesen werden. Prüfen Sie die Eingabeform.',
	'pid.salt.error.limit': 'Für diesen Mandanten können keine weiteren Salts importiert werden.',
	'pid.salt.error.lookup':
		'Das gespeicherte Salt konnte nicht geprüft werden. Bitte versuchen Sie es erneut.',
	'pid.salt.error.generic':
		'Das Salt konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.',
	'pid.salt.replaceTitle': 'Salt „{name}“ ersetzen?',
	'pid.salt.replaceBody':
		'Unter diesem Namen ist ein anderes Salt gespeichert (Fingerabdruck {fingerprint}). Beim Ersetzen ändern sich alle damit erzeugten Kennungen.',
	'pid.salt.replaceConfirm': 'Ersetzen',

	'pid.csv.title.source': 'Kennungsquelle aus CSV importieren',
	'pid.csv.title.store': 'Gespeicherte Kennungen aus CSV importieren',
	'pid.csv.title.exceptions': 'Ausnahmenliste aus CSV importieren',
	'pid.csv.name': 'Name',
	'pid.csv.help.source':
		'Erste Zeile: {header}. account ist die Konto-ID; value ist der Wert, aus dem die Kennung entsteht.',
	'pid.csv.help.store':
		'Erste Zeile: {header}. audience ist der Empfänger, account die Konto-ID und identifier die Kennung beim anderen IdP.',
	'pid.csv.help.exceptions':
		'Erste Zeile: {header}. account und audience können auch * sein. action ist salt oder block; salt nennt ein importiertes Salt (bei block leer).',
	'pid.csv.limits': 'Bis zu 5.000 Zeilen und 2 MiB.',
	'pid.csv.replacesList':
		'Die Liste wird vollständig durch diese Datei ersetzt. Eine Datei nur mit der ersten Zeile leert die Liste.',
	'pid.csv.file': 'CSV-Datei',
	'pid.csv.paste': 'Inhalt',
	'pid.csv.submit': 'Importieren',
	'pid.csv.error.empty': 'Wählen Sie eine CSV-Datei oder geben Sie den Inhalt ein.',
	'pid.csv.error.invalid':
		'Die Datei konnte nicht gelesen werden. Prüfen Sie die erste Zeile und den Inhalt.',
	'pid.csv.error.othersValues':
		'{count} Werte werden bereits von anderen Konten verwendet und können nicht ersetzt werden. Prüfen Sie die Datei.',
	'pid.csv.error.changed':
		'Die Daten haben sich während des Imports geändert. Bitte versuchen Sie es erneut.',
	'pid.csv.error.generic': 'Der Import war nicht möglich. Bitte versuchen Sie es erneut.',
	'pid.csv.error.readFailed': 'Die Datei konnte nicht gelesen werden.',
	'pid.csv.rowsTitle': '{count} Zeilen haben ein Problem. Es wurde nichts gespeichert.',
	'pid.csv.rowsMore': 'Die ersten {count} Zeilen werden angezeigt.',
	'pid.csv.rowItem': 'Zeile {row}, {column}: {reason}',
	'pid.csv.rowItemWhole': 'Zeile {row}: {reason}',
	'pid.csv.rowUnknown': 'Diese Zeile kann nicht importiert werden ({code}).',
	'pid.csv.replaceTitle.source': '{count} Werte ersetzen?',
	'pid.csv.replaceTitle.store': '{count} Kennungen ersetzen?',
	'pid.csv.replaceBody.source':
		'{count} Konten haben in dieser Quelle bereits einen anderen Wert. Beim Ersetzen ändern sich deren Kennungen.',
	'pid.csv.replaceBody.store':
		'{count} Konten haben in diesem Speicher bereits eine andere Kennung. Beim Ersetzen ändern sich deren Kennungen.',
	'pid.csv.replaceConfirm': 'Ersetzen',
	'pid.csv.listReplaceTitle': 'Ausnahmenliste „{name}“ ersetzen?',
	'pid.csv.listReplaceBody': 'Die Liste wird vollständig durch den Inhalt dieser Datei ersetzt.',
	'pid.csv.listEmptyBody':
		'Diese Datei enthält nur die erste Zeile, daher wird die Liste leer. Alle Ausnahmen entfallen.',
	'pid.csv.listEmptyConfirm': 'Liste leeren',

	'pid.rowError.field_count': 'die Anzahl der Spalten stimmt nicht',
	'pid.rowError.required': 'der Wert fehlt',
	'pid.rowError.too_long': 'der Wert ist zu lang',
	'pid.rowError.invalid_account': 'die Konto-ID ist ungültig',
	'pid.rowError.control_characters': 'der Wert enthält ein Steuerzeichen oder einen Zeilenumbruch',
	'pid.rowError.surrounding_whitespace': 'am Anfang oder Ende steht ein Leerzeichen',
	'pid.rowError.whitespace': 'der Wert enthält ein Leerzeichen',
	'pid.rowError.unknown_account': 'dieses Konto gibt es im Mandanten nicht',
	'pid.rowError.another_value_for_account': 'das Konto hat in dieser Datei einen anderen Wert',
	'pid.rowError.value_of_another_account': 'derselbe Wert gehört zu einem anderen Konto',
	'pid.rowError.value_retired':
		'der Wert wurde schon einmal einem Konto zugewiesen und kann nicht erneut verwendet werden',
	'pid.rowError.another_identifier_for_account':
		'das Konto hat in dieser Datei eine andere Kennung',
	'pid.rowError.identifier_of_another_account': 'dieselbe Kennung gehört zu einem anderen Konto',
	'pid.rowError.duplicate': 'Konto und Empfänger kommen doppelt vor',
	'pid.rowError.invalid_action': 'action muss salt oder block sein',
	'pid.rowError.not_allowed': 'bei block muss salt leer sein',
	'pid.rowError.invalid_salt_name': 'der Name des Salts ist ungültig',
	'pid.rowError.unknown_salt': 'dieses Salt wurde nicht importiert'
};
