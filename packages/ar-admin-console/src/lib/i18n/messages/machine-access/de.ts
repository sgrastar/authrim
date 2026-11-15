import type { jaMachineAccess } from './ja';

export const deMachineAccess: Record<keyof typeof jaMachineAccess, string> = {
	'mc.page.desc':
		'Hier registrieren Sie Automatisierungen und Systeme, die die Admin-API von Authrim anstelle eines Menschen nutzen. Eine Maschine meldet sich an, indem sie mit ihrem eigenen privaten Schlüssel signiert (private_key_jwt); Authrim speichert nur den öffentlichen Schlüssel.',
	'mc.create': 'Neu',
	'mc.advanced': 'Erweiterte Einstellungen',

	'mc.list.title': 'Maschinen',
	'mc.list.noAccess': 'Sie haben keinen Zugriff auf den Maschinenzugriff',
	'mc.list.loadFailed': 'Die Maschinen konnten nicht geladen werden',
	'mc.list.empty': 'Noch keine Maschinen',
	'mc.list.emptyBody':
		'Der Maschinenzugriff erlaubt etwas, das keine Person ist, etwa einem CI-Job oder einer Automatisierung, die Admin-API zu nutzen. Wählen Sie „Neu“, um eine Maschine zu registrieren, und fügen Sie dann ihren öffentlichen Schlüssel hinzu, damit sie sich anmelden kann.',
	'mc.list.open': '{name} öffnen',
	'mc.list.col.name': 'Name / Client-ID',
	'mc.list.col.type': 'Art',
	'mc.list.col.status': 'Status',
	'mc.list.col.keys': 'Gültige Schlüssel',
	'mc.list.col.updated': 'Geändert',

	'mc.status.active': 'Aktiv',
	'mc.status.disabled': 'Deaktiviert',
	'mc.status.deleted': 'Gelöscht',

	'mc.type.automation': 'Automatisierung',
	'mc.type.ci': 'CI / Deployment',
	'mc.type.integration': 'Anbindung eines externen Dienstes',
	'mc.type.mcp_server': 'MCP-Server',
	'mc.type.ai_agent': 'KI-Agent',
	'mc.type.internal_service': 'Interner Dienst (Plattform)',
	'mc.type.setup_tool': 'Einrichtungswerkzeug (Plattform)',
	'mc.type.admin_ui_bff': 'Weiterleitung der Admin-Konsole (Plattform)',

	'mc.reach.none': 'Keine Mandanten',
	'mc.reach.noneDesc': 'Auch mit Berechtigungen ist sie in keinem Mandanten nutzbar.',
	'mc.reach.tenants': 'Nur ausgewählte Mandanten',
	'mc.reach.tenantsDesc': 'Sie funktioniert nur in den unten gewählten Mandanten.',
	'mc.reach.all': 'Alle Mandanten',
	'mc.reach.allDesc': 'Sie funktioniert auf der ganzen Plattform. Wählen Sie dies nur, wenn nötig.',

	'mc.f.name': 'Anzeigename',
	'mc.f.clientId': 'Client-ID',
	'mc.f.clientIdHint':
		'Die ID, mit der sich die Maschine bei der Anmeldung nennt. Keine Leerzeichen; sie lässt sich später nicht ändern.',
	'mc.f.permissions': 'Berechtigungen',
	'mc.f.permissionsHint':
		'Eine Berechtigung pro Zeile (zum Beispiel admin:users:read). Sie können nur Berechtigungen vergeben, die Sie selbst haben.',
	'mc.f.permissionAdd': 'Berechtigung hinzufügen',
	'mc.f.reach': 'Erreichbare Mandanten',
	'mc.f.reachTenants': 'Mandanten',
	'mc.f.description': 'Beschreibung',
	'mc.f.type': 'Art',
	'mc.f.typeHint':
		'Wofür sie genutzt wird. Die Plattform-Arten kann nur ein Plattform-Administrator anlegen.',
	'mc.f.ttl': 'Gültigkeit des Tokens',
	'mc.f.ttlUnit': 'Sekunden',
	'mc.f.ttlHint':
		'Wie lange ein ausgestelltes Zugriffstoken gültig bleibt. Höchstens {max} Sekunden.',

	'mc.perm.space': 'Eine Berechtigung darf keine Leerzeichen enthalten',
	'mc.perm.long': 'Diese Berechtigung ist zu lang',

	'mc.new.title': 'Maschine registrieren',
	'mc.new.desc':
		'Damit werden Berechtigungen und Mandantenzugriff vergeben. Beim Speichern kann daher eine zusätzliche Identitätsprüfung (Step-up) verlangt werden.',
	'mc.new.submit': 'Registrieren',
	'mc.new.advancedDesc':
		'Beschreibung, Art und Gültigkeit des Tokens. Meist müssen Sie daran nichts ändern.',
	'mc.new.nameRequired': 'Geben Sie einen Anzeigenamen ein',
	'mc.new.clientIdInvalid': 'Geben Sie eine Client-ID ohne Leerzeichen ein',
	'mc.new.clientIdTaken': 'Diese Client-ID wird bereits verwendet',
	'mc.new.reachNoTenants': 'Wählen Sie mindestens einen Mandanten',
	'mc.new.permissionsInvalid': 'Eine der Berechtigungen ist ungültig',
	'mc.new.ttlRange': 'Die Gültigkeit des Tokens muss eine ganze Zahl von 1 bis {max} Sekunden sein',

	'mc.d.back': 'Zurück zum Maschinenzugriff',
	'mc.d.notFound': 'Diese Maschine wurde nicht gefunden',
	'mc.d.loadFailed': 'Die Maschine konnte nicht geladen werden',
	'mc.d.disabledNote':
		'Diese Maschine ist deaktiviert. Sie kann sich nicht anmelden, auch wenn sie Schlüssel hat.',
	'mc.d.deletedNote':
		'Diese Maschine wurde gelöscht. Sie lässt sich auf diesem Bildschirm weder ändern noch wiederherstellen.',
	'mc.d.overview': 'Maschine',
	'mc.d.status': 'Status',
	'mc.d.edit': 'Bearbeiten',
	'mc.d.edit.title': 'Einstellungen der Maschine',
	'mc.d.edit.save': 'Speichern',
	'mc.d.enable': 'Aktivieren',
	'mc.d.disable': 'Deaktivieren',
	'mc.d.disable.title': 'Diese Maschine deaktivieren?',
	'mc.d.disable.body':
		'Eine deaktivierte Maschine kann sich nicht anmelden, ihre Schlüssel bleiben aber unverändert. Sie können sie später wieder aktivieren (das verlangt eine zusätzliche Identitätsprüfung).',
	'mc.d.advancedDesc': 'Beschreibung, Art und Gültigkeit des Tokens',
	'mc.d.none': 'Keine',
	'mc.d.ttlValue': '{seconds} Sekunden',
	'mc.d.updated': 'Geändert',
	'mc.d.access': 'Berechtigungen und Mandanten',
	'mc.d.accessDesc': 'Was diese Maschine darf und in welchen Mandanten.',
	'mc.d.access.title': 'Berechtigungen und Mandanten ändern',
	'mc.d.access.note':
		'Damit wird Zugriff vergeben. Beim Speichern kann daher eine zusätzliche Identitätsprüfung (Step-up) verlangt werden.',
	'mc.d.noPermissions': 'Noch keine Berechtigungen',

	'mc.key.title': 'Signaturschlüssel',
	'mc.key.desc':
		'Eine Maschine meldet sich mit einem Nachweis an, den sie mit ihrem eigenen privaten Schlüssel signiert. Authrim speichert nur den öffentlichen Schlüssel. Um einen Schlüssel zu ersetzen, fügen Sie zuerst den neuen hinzu und widerrufen dann den alten.',
	'mc.key.add': 'Schlüssel hinzufügen',
	'mc.key.empty': 'Keine Schlüssel',
	'mc.key.emptyBody':
		'Fügen Sie einen öffentlichen Schlüssel hinzu, damit sich diese Maschine anmelden kann.',
	'mc.key.col.kid': 'Schlüssel-ID (kid)',
	'mc.key.col.alg': 'Algorithmus',
	'mc.key.col.status': 'Status',
	'mc.key.col.expires': 'Läuft ab',
	'mc.key.col.actions': 'Aktionen',
	'mc.key.status.active': 'Aktiv',
	'mc.key.status.rotating': 'Wird ersetzt',
	'mc.key.status.revoked': 'Widerrufen',
	'mc.key.status.expired': 'Abgelaufen',
	'mc.key.status.notYet': 'Noch nicht gültig',
	'mc.key.noEnd': 'Läuft nicht ab',
	'mc.key.revoke': 'Widerrufen',
	'mc.key.revokeTitle': 'Schlüssel {kid} widerrufen?',
	'mc.key.revokeBody':
		'Die Maschine kann sich mit diesem Schlüssel nicht mehr anmelden. Das lässt sich nicht rückgängig machen.',

	'mc.key.new.title': 'Schlüssel hinzufügen',
	'mc.key.new.submit': 'Hinzufügen',
	'mc.key.new.note':
		'Fügen Sie nur den öffentlichen Schlüssel ein. Senden Sie den privaten Schlüssel niemals an Authrim; er bleibt auf der Maschine. Der Schlüssel nutzt die Berechtigungen und Mandanten der Maschine.',
	'mc.key.kid': 'Schlüssel-ID (kid)',
	'mc.key.kidHint':
		'Ein Name für den Schlüssel. Er muss mit der kid übereinstimmen, mit der die Maschine signiert.',
	'mc.key.kidRequired': 'Geben Sie eine Schlüssel-ID ein',
	'mc.key.kidTaken': 'Diese Maschine hat bereits einen Schlüssel mit dieser ID',
	'mc.key.jwk': 'Öffentlicher Schlüssel (JWK)',
	'mc.key.jwkHint':
		'Fügen Sie JSON in dieser Form ein: { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" }.',
	'mc.key.advancedDesc':
		'Algorithmus, Schlüsselname und Ablauf. Meist müssen Sie daran nichts ändern.',
	'mc.key.alg': 'Algorithmus',
	'mc.key.algAuto': 'Aus dem Schlüssel ableiten',
	'mc.key.algHint': 'ES256, PS256 und RS256 werden unterstützt.',
	'mc.key.name': 'Schlüsselname',
	'mc.key.nameHint': 'Leer gelassen, wird die Schlüssel-ID verwendet.',
	'mc.key.days': 'Gültig für',
	'mc.key.daysUnit': 'Tage',
	'mc.key.daysHint': 'Leer gelassen, läuft der Schlüssel nicht ab.',
	'mc.key.daysInvalid': 'Die Anzahl der Tage muss eine ganze Zahl ab 1 sein',

	'mc.key.jwk.empty': 'Fügen Sie den öffentlichen Schlüssel ein',
	'mc.key.jwk.notJson': 'Das ist kein gültiges JSON. Fügen Sie es unverändert ein, von { bis }',
	'mc.key.jwk.notObject': 'Der Schlüssel muss ein JSON-Objekt in { } sein',
	'mc.key.jwk.private':
		'Das enthält Bestandteile eines privaten Schlüssels (d, p, q …). Fügen Sie nur den öffentlichen Schlüssel ein. Halten Sie diesen Schlüssel geheim und senden Sie ihn nicht',
	'mc.key.jwk.keyType':
		'Dieser Schlüsseltyp wird nicht unterstützt. Verwenden Sie einen öffentlichen EC-Schlüssel (P-256) oder RSA-Schlüssel',
	'mc.key.jwk.algorithm': 'Schlüsseltyp und Algorithmus passen nicht zusammen',
	'mc.key.jwk.use': 'Verwenden Sie einen Signaturschlüssel (use auf sig)',
	'mc.key.jwk.keyOps':
		'key_ops, die Signieren oder Entschlüsseln erlauben, werden nicht akzeptiert',

	'mc.toast.created':
		'{name} wurde registriert. Fügen Sie als Nächstes den öffentlichen Schlüssel hinzu',
	'mc.toast.saved': 'Gespeichert',
	'mc.toast.enabled': 'Aktiviert',
	'mc.toast.disabled': 'Deaktiviert',
	'mc.toast.keyAdded': 'Schlüssel {kid} wurde hinzugefügt',
	'mc.toast.keyRevoked': 'Schlüssel {kid} wurde widerrufen',

	'mc.error.cancelled': 'Die Identitätsprüfung wurde abgebrochen, daher wurde nichts gesendet.',
	'mc.error.capabilityOff':
		'Die Plattform hat das Vergeben neuer Maschinenschlüssel und Berechtigungen abgeschaltet.',
	'mc.error.invalid':
		'Die Anfrage wurde nicht akzeptiert. Möglicherweise dürfen Sie eine dieser Berechtigungen oder Mandanten nicht vergeben. Prüfen Sie die Werte.',
	'mc.error.forbidden': 'Sie haben keine Berechtigung für diese Aktion.',
	'mc.error.notFound':
		'Die Maschine wurde nicht gefunden. Gehen Sie zur Liste zurück und prüfen Sie.',
	'mc.error.conflict':
		'Dieser Name wird bereits verwendet, oder jemand anderes hat zuerst etwas geändert. Laden Sie neu und prüfen Sie.',
	'mc.error.generic': 'Es konnte nicht gespeichert werden. Versuchen Sie es erneut.'
};
