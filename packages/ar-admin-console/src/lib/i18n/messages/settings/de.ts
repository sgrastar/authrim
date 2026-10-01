import type { jaSettings } from './ja';

export const deSettings: Record<keyof typeof jaSettings, string> = {
	'set.page.stayingSignedIn': 'Angemeldet bleiben',
	'set.page.stayingSignedIn.desc':
		'Wie lange Personen nach der Anmeldung angemeldet bleiben und wie lange ihre Apps diese Anmeldung behalten.',

	'set.section.signIn': 'Dauer der Anmeldung',
	'set.section.signIn.desc': 'Wie lange eine Person bei Authrim angemeldet bleibt.',
	'set.section.signIn.advanced': 'Dauer je Anmeldemethode und erlaubter Bereich',
	'set.section.appTokens': 'Tokens für Apps',
	'set.section.appTokens.desc':
		'Wie lange die Tokens gültig sind, mit denen Apps eine Anmeldung weiter nutzen.',
	'set.section.appTokens.advanced': 'ID-Tokens und wie Refresh-Tokens erneuert werden',
	'set.section.logout': 'Abmeldebenachrichtigungen',
	'set.section.logout.desc':
		'Was passiert, wenn Authrim Apps mitteilt, dass sich eine Person abgemeldet hat (Back-Channel-Logout).',
	'set.section.logout.advanced': 'Wenn eine Benachrichtigung nicht ankommt, und Wiederholungen',

	'set.k.session.default_ttl': 'Angemeldet halten für',
	'set.k.session.default_ttl.desc':
		'Zeit von der Anmeldung, bis sich die Person erneut anmelden muss. Je Anmeldemethode unter „Erweitert“ festlegen.',
	'set.k.session.refresh_default': 'Anmeldung verlängern, solange sie genutzt wird',
	'set.k.session.refresh_default.desc':
		'Jede Aktion startet die Zeit neu (sofern eine App nichts anderes verlangt).',
	'set.k.oauth.sso_enabled': 'Anmeldung zwischen Apps teilen (Single Sign-on)',
	'set.k.oauth.sso_enabled.desc':
		'Einmal angemeldet, öffnet eine Person die anderen Apps des Mandanten ohne erneute Anmeldung. Aus: Jede App verlangt eine Anmeldung.',
	'set.k.session.ttl.passkey': 'Nach Anmeldung mit Passkey',
	'set.k.session.ttl.email_code': 'Nach Anmeldung mit E-Mail-Code',
	'set.k.session.ttl.directory_password': 'Nach Anmeldung mit Verzeichnispasswort',
	'set.k.session.ttl.direct_auth': 'Nach Anmeldung mit Direct Auth',
	'set.k.session.ttl.did': 'Nach Anmeldung mit einer DID',
	'set.k.session.ttl.guest': 'Nach Anmeldung als Gast',
	'set.k.session.ttl.passkey_registration': 'Direkt nach dem Registrieren eines Passkeys',
	'set.k.session.max_ttl': 'Längste erlaubte Anmeldung',
	'set.k.session.max_ttl.desc':
		'Die längste Zeit, die für das Angemeldetbleiben festgelegt werden kann.',
	'set.k.session.min_ttl': 'Kürzeste erlaubte Anmeldung',
	'set.k.session.min_ttl.desc':
		'Die kürzeste Zeit, die für das Angemeldetbleiben festgelegt werden kann.',
	'set.k.session.token_ttl': 'Gültigkeit des Sitzungstokens',
	'set.k.session.token_ttl.desc': 'Wie lange das Token zur Verwaltung von Sitzungen gültig ist.',
	'set.k.session.tombstone_ttl': 'Beendete Sitzungen merken für',
	'set.k.session.tombstone_ttl.desc':
		'Wie lange eine beendete Sitzung (z. B. nach der Abmeldung) gemerkt wird, um sie abzulehnen.',

	'set.k.oauth.access_token_expiry': 'Gültigkeit des Access-Tokens',
	'set.k.oauth.access_token_expiry.desc':
		'Das Token, mit dem eine App APIs aufruft. Je kürzer, desto weniger kann ein kompromittiertes Token anrichten.',
	'set.k.oauth.refresh_token_expiry': 'Gültigkeit des Refresh-Tokens',
	'set.k.oauth.refresh_token_expiry.desc':
		'Wie lange eine App neue Access-Tokens erhält, ohne dass sich die Person erneut anmeldet.',
	'set.k.oauth.id_token_expiry': 'Gültigkeit des ID-Tokens',
	'set.k.oauth.id_token_expiry.desc': 'Das Token, das einer App mitteilt, wer sich angemeldet hat.',
	'set.k.oauth.refresh_token_rotation': 'Refresh-Token bei jeder Nutzung ersetzen',
	'set.k.oauth.refresh_token_rotation.desc':
		'Ein benutztes Token wird ungültig, ein kompromittiertes kann also nicht erneut verwendet werden. Empfohlen: eingeschaltet lassen.',
	'set.k.oauth.refresh_token_sliding_window_enabled': 'Gültigkeit bei jeder Nutzung verlängern',
	'set.k.oauth.refresh_token_sliding_window_enabled.desc':
		'Jede Nutzung des Refresh-Tokens startet seine Gültigkeit neu.',
	'set.k.oauth.refresh_token_absolute_expiry_enabled':
		'Obergrenze festlegen, die Verlängern nicht überschreitet',
	'set.k.oauth.refresh_token_absolute_expiry_enabled.desc':
		'Begrenzt die Zeit seit dem ersten Token. Danach meldet sich die Person erneut an.',
	'set.k.oauth.refresh_token_absolute_expiry': 'Obergrenze (ab dem ersten Token)',
	'set.k.oauth.refresh_token_remaining_expiry_inherit':
		'Ein neues Token übernimmt die Restzeit des alten',
	'set.k.oauth.refresh_token_remaining_expiry_inherit.desc':
		'Aus: Die Gültigkeit eines neuen Tokens beginnt bei seiner Ausstellung.',
	'set.k.oauth.offline_access_required': 'Nur an Apps ausstellen, die offline_access anfordern',
	'set.k.oauth.offline_access_required.desc':
		'Aus: Refresh-Tokens werden unabhängig von den angeforderten Scopes ausgestellt.',
	'set.k.oauth.refresh_id_token_reissue': 'Beim Erneuern auch ein neues ID-Token ausstellen',

	'set.k.session.backchannel_on_failure': 'Wenn eine Benachrichtigung nicht ankommt',
	'set.k.session.backchannel_on_failure.desc':
		'Was geschieht, wenn auch Wiederholungen die Benachrichtigung nicht zustellen.',
	'set.k.session.backchannel_on_failure.ignore': 'Nichts',
	'set.k.session.backchannel_on_failure.log': 'Ins Protokoll schreiben',
	'set.k.session.backchannel_on_failure.error': 'Als Fehler behandeln',
	'set.k.session.backchannel_retry_max_attempts': 'Wiederholungen',
	'set.k.session.backchannel_logout_token_exp': 'Gültigkeit des Logout-Tokens',
	'set.k.session.backchannel_request_timeout_ms': 'Auf die Antwort der App warten',
	'set.k.session.backchannel_retry_initial_delay_ms': 'Zeit bis zur ersten Wiederholung',
	'set.k.session.backchannel_retry_max_delay_ms': 'Längste Zeit zwischen Wiederholungen',
	'set.k.session.backchannel_retry_backoff_multiplier':
		'Faktor, um den die Zeit zwischen Wiederholungen wächst',

	'settings.advanced': 'Erweitert',
	'settings.setHere': 'Überschriebene Einstellungen: {n}',
	'settings.readOnly.title': 'Nur ansehen',
	'settings.readOnly.body':
		'Sie können diese Einstellungen nicht ändern. Bitten Sie eine berechtigte Person um die Änderung.',
	'settings.rejected': 'Dieser Wert konnte nicht gespeichert werden ({reason})',
	'settings.partial':
		'Einige Einstellungen konnten nicht gespeichert werden. Prüfen Sie die markierten.',
	'settings.setHereOption': 'Überschreiben',
	'settings.defaultFrom.platform': 'Plattform-Standard: {value}',
	'settings.defaultFrom.tenant': 'Mandanten-Standard: {value}',
	'settings.locked.platform': 'Durch die Plattform-Einstellungen festgelegt',
	'settings.locked.tenant': 'Durch die Mandanten-Einstellungen festgelegt',
	'settings.badge.locked': 'Gesperrt',
	'settings.badge.here': 'Überschrieben',
	'settings.value.on': 'Ein',
	'settings.value.off': 'Aus',
	'settings.value.empty': '(keine)',
	'settings.conflict.title': 'Jemand anderes hat zuerst gespeichert',
	'settings.conflict.body':
		'Seit Sie diese Seite geöffnet haben, hat eine andere Person diese Einstellungen geändert:',
	'settings.conflict.reload': 'Neueste Werte laden',
	'settings.conflict.reload.desc': 'Ihre Änderungen werden verworfen.',
	'settings.conflict.overwrite': 'Meine Änderungen darüber speichern',
	'settings.conflict.overwrite.desc':
		'Nur die von Ihnen geänderten Einstellungen werden auf den neuesten Werten gespeichert.',

	'inherit.usingDeployment': 'Einstellung der Bereitstellung wird verwendet',
	'inherit.sourceBuiltIn': 'Authrim',

	'access.none.title': 'Sie können diese Seite nicht sehen',
	'access.none.body': 'Öffnen Sie eine andere Seite oder bitten Sie eine berechtigte Person.',
	'load.error.title': 'Konnte nicht geladen werden',
	'load.error.body': 'Versuchen Sie es gleich noch einmal.',
	'load.retry': 'Erneut versuchen',

	'persona.label': 'Art der Administration',
	'persona.platform': 'Plattform-Admin',
	'persona.platform.desc': 'Betreibt die gesamte Installation: alle Mandanten und die Plattform.',
	'persona.tenant': 'Mandanten-Admin',
	'persona.tenant.desc': 'Betreibt einen Mandanten: seine Benutzer, Apps und Einstellungen.',
	'persona.support': 'Support (eingeschränkt)',
	'persona.support.desc': 'Hilft nur Benutzern (entsperren, abmelden). Sieht keine Einstellungen.',
	'persona.viewer': 'Lesezugriff (eingeschränkt)',
	'persona.viewer.desc': 'Sieht Benutzer, Apps und Einstellungen und ändert nichts.'
};
