import type { jaSettings } from './ja';

export const deSettings: Record<keyof typeof jaSettings, string> = {
	'set.page.stayingSignedIn': 'Angemeldet bleiben',
	'set.page.stayingSignedIn.desc':
		'Wie lange Personen nach der Anmeldung angemeldet bleiben und wie lange ihre Apps diese Anmeldung behalten.',
	'set.page.signingKeys': 'Signaturschlüssel',
	'set.page.signingKeys.desc': 'Wie dieser Mandant seine Tokens signiert.',
	'set.section.idTokenSigning': 'Signatur von ID-Tokens',
	'set.section.idTokenSigning.desc':
		'Der Algorithmus, mit dem ID-Tokens signiert werden, und ob Apps ihren eigenen wählen dürfen.',

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
		'Zeit, bis sich die Person erneut anmelden muss, für Anmeldungen ohne eigene Zeit, etwa über einen externen IdP oder SAML. Passkeys, E-Mail-Codes und die anderen Methoden unter „Erweitert“ festlegen.',
	'set.k.session.refresh_default': 'Anmeldung verlängern, solange sie genutzt wird',
	'set.k.session.refresh_default.desc':
		'Wenn eine App die Verlängerung anfordert (/api/sessions/refresh), beginnt die Zeit ab dann neu. Aus: keine Verlängerung. Eine Verlängerung überschreitet nie die längste Zeit zum Angemeldetbleiben.',
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
		'Die längste Dauer einer Anmeldung, Verlängerungen eingeschlossen. Eine längere Zeit einer Anmeldemethode wird darauf gekürzt.',

	'set.k.oauth.access_token_expiry': 'Gültigkeit des Access-Tokens',
	'set.k.oauth.access_token_expiry.desc':
		'Das Token, mit dem eine App APIs aufruft. Je kürzer, desto weniger kann ein kompromittiertes Token anrichten.',
	'set.k.oauth.refresh_token_expiry': 'Gültigkeit des Refresh-Tokens',
	'set.k.oauth.refresh_token_expiry.desc':
		'Wie lange eine App neue Access-Tokens erhält, ohne dass sich die Person erneut anmeldet.',
	'set.k.oauth.id_token_expiry': 'Gültigkeit des ID-Tokens',
	'set.k.oauth.id_token_expiry.desc': 'Das Token, das einer App mitteilt, wer sich angemeldet hat.',
	'set.k.oauth.refresh_token_rotation': 'Refresh-Token bei jeder Nutzung ersetzen',
	'set.k.oauth.id_token_signing_alg': 'Signaturalgorithmus für ID-Tokens',
	'set.k.oauth.id_token_signing_alg.desc':
		'Signiert die ID-Tokens von Apps, die keinen eigenen Algorithmus wählen.',
	'set.k.oauth.id_token_signing_alg_client_override': 'Apps dürfen ihren Algorithmus wählen',
	'set.k.oauth.id_token_signing_alg_client_override.desc':
		'Aus: Jedes ID-Token wird mit dem Algorithmus des Mandanten signiert, und Apps mit einem anderen werden abgelehnt.',
	'set.k.security.fapi_enabled': 'FAPI 2.0 anwenden',
	'set.k.security.fapi_enabled.desc':
		'Das FAPI-2.0-Sicherheitsprofil auf alle Apps des Mandanten anwenden.',
	'set.page.appDefaults': 'App-Standards',
	'set.page.appDefaults.desc':
		'Regeln für Autorisierungsanfragen und Tokens, die für alle Apps des Mandanten gelten. Die Einstellungen einer App können eine Sicherheitsanforderung hinzufügen, aber keine aufheben.',
	'set.section.authRequests': 'Autorisierungsanfragen',
	'set.section.authRequests.desc': 'Was die Anmeldeanfrage einer App enthalten muss.',
	'set.section.authRequests.advanced': 'Signierte und verschlüsselte Request Objects',
	'set.section.redirectUris': 'Weiterleitungs-URIs',
	'set.section.redirectUris.desc': 'Wohin die Anmeldung zu einer App zurückkehren darf.',
	'set.section.senderConstrained': 'Absendergebundene Tokens',
	'set.section.senderConstrained.desc': 'An den Schlüssel der empfangenden App gebundene Tokens.',
	'set.section.senderConstrained.advanced': 'DPoP unter FAPI und Nonces',
	'set.section.fapi': 'FAPI',
	'set.section.fapi.desc': 'Das Sicherheitsprofil für Finanzanwendungen (FAPI 2.0).',
	'set.section.fapi.advanced': 'Einzelne FAPI-Anforderungen',
	'set.section.tokenExchange': 'Token-Austausch',
	'set.section.tokenExchange.desc': 'Der Austausch eines Tokens einer App gegen ein anderes.',
	'set.section.tokenExchange.advanced': 'Delegation und Identitätsübernahme',
	'set.k.security.pkce_required': 'PKCE verlangen',
	'set.k.security.pkce_required.desc':
		'Jede Anfrage mit Autorisierungscode muss PKCE (S256) enthalten. Eine App kann es ebenfalls verlangen, die Anforderung des Mandanten aber nicht aufheben.',
	'set.k.security.par_required': 'PAR verlangen',
	'set.k.security.par_required.desc':
		'Autorisierungsanfragen müssen zuerst serverseitig übermittelt werden (Pushed Authorization Request).',
	'set.k.oauth.state_required': 'state-Parameter verlangen',
	'set.k.oauth.state_required.desc': 'Autorisierungsanfragen ohne state ablehnen (CSRF-Schutz).',
	'set.k.security.require_signed_request_object': 'Signierte Request Objects verlangen',
	'set.k.security.require_signed_request_object.desc':
		'Autorisierungsanfragen müssen in einem von der App signierten Request Object kommen.',
	'set.k.security.require_encrypted_request_object': 'Verschlüsselte Request Objects verlangen',
	'set.k.security.require_encrypted_request_object.desc':
		'Autorisierungsanfragen müssen in einem Request Object kommen, das mit dem Verschlüsselungsschlüssel des Mandanten (use enc im JWKS) verschlüsselt ist. Apps müssen das unterstützen.',
	'set.k.security.allow_unsigned_request_object':
		'Unsignierte Request Objects zulassen (Entwicklung)',
	'set.k.security.allow_unsigned_request_object.desc':
		'In der Produktion nie zugelassen, unabhängig von dieser Einstellung.',
	'set.k.security.https_redirect_only': 'Nur HTTPS-Weiterleitungs-URIs zulassen',
	'set.k.security.https_redirect_only.desc':
		'Der Loopback einer nativen App (localhost u. Ä.) darf http verwenden. Aus: Auch eine Web-App darf auf einem Loopback-Host http verwenden (Entwicklung).',
	'set.k.security.dpop_bound_access_tokens': 'Zugriffstokens an DPoP binden',
	'set.k.security.dpop_bound_access_tokens.desc':
		'Zum Erhalt von Tokens ist ein DPoP-Nachweis erforderlich, damit ein abgeflossenes Token von niemand anderem verwendet werden kann. Apps müssen das unterstützen.',
	'set.k.security.dpop_required': 'DPoP unter FAPI',
	'set.k.security.dpop_required.desc': 'Ob DPoP verlangt wird, solange FAPI gilt.',
	'set.k.security.dpop_required.with_fapi': 'Mit FAPI verlangt',
	'set.k.security.dpop_required.always': 'Immer verlangt',
	'set.k.security.dpop_required.never': 'Nie verlangt',
	'set.k.security.dpop_nonce_enabled': 'DPoP-Server-Nonces verwenden',
	'set.k.security.dpop_nonce_enabled.desc':
		'DPoP-Nachweise müssen eine vom Server ausgegebene Nonce enthalten, was ihre Wiederverwendung verhindert.',
	'set.k.security.fapi_strict_dpop': 'DPoP streng prüfen',
	'set.k.security.fapi_strict_dpop.desc':
		'Eine Autorisierungsanfrage mit ungültigem DPoP-Nachweis ablehnen.',
	'set.k.security.fapi_allow_public_clients': 'Öffentliche Clients zulassen',
	'set.k.security.fapi_allow_public_clients.desc':
		'Apps ohne Geheimnis (Browser- und Mobil-Apps) zulassen, solange FAPI gilt.',
	'set.k.security.fapi_require_private_key_jwt': 'private_key_jwt verlangen',
	'set.k.security.fapi_require_private_key_jwt.desc':
		'Apps authentifizieren sich nur mit private_key_jwt.',
	'set.k.security.require_jarm': 'Signierte Autorisierungsantworten (JARM) verlangen',
	'set.k.tokens.exchange_enabled': 'Token-Austausch aktivieren',
	'set.k.tokens.exchange_enabled.desc':
		'Apps können ein Token gegen ein anderes austauschen (RFC 8693).',
	'set.k.tokens.exchange_delegation_enabled': 'Delegation zulassen',
	'set.k.tokens.exchange_delegation_enabled.desc':
		'Eine App kann im Namen einer Person ein Token für einen anderen Dienst erhalten. Solange dies aus ist, wird Apps im Delegationsmodus (Standard) der Token-Austausch verweigert. Der Delegationsmodus der einzelnen App kann es weiter einschränken.',
	'set.k.tokens.exchange_impersonation_enabled': 'Identitätsübernahme zulassen',
	'set.k.tokens.exchange_impersonation_enabled.desc':
		'Eine App kann ein Token erhalten, das als die Person selbst handelt. Solange dies aus ist, wird Apps im Modus Identitätsübernahme der Token-Austausch verweigert. Es hat große Sicherheitsauswirkungen: nur bei Bedarf einschalten.',
	'set.page.protection': 'Angriffsschutz',
	'set.page.protection.desc': 'Schützt E-Mails zu Anmeldung und Registrierung vor Missbrauch.',
	'set.section.emailSending': 'Sendelimit für E-Mails',
	'set.section.emailSending.desc':
		'Begrenzt, wie oft E-Mails wie Anmeldecodes hintereinander an denselben Empfänger gesendet werden können, damit sie nicht für Spam missbraucht werden.',
	'set.k.rate_limit.email_max_requests': 'Erlaubte Sendungen pro Zeitraum',
	'set.k.rate_limit.email_max_requests.desc':
		'Wie viele Codes für Anmeldung, Registrierung, erneute Authentifizierung und Verzeichnismigration an dieselbe E-Mail-Adresse (oder denselben Benutzer) gesendet werden können. Codes für die Kontosuche haben ein eigenes Limit.',
	'set.k.rate_limit.email_window': 'Zeitraum, in dem gezählt wird',
	'set.k.rate_limit.email_window.desc':
		'Der Zeitraum, in dem die Zahl oben gezählt wird (5 bis 60 Minuten). Danach darf wieder gesendet werden.',
	'set.section.introspection': 'Token-Introspektion',
	'set.section.introspection.desc':
		'Die Antwort, die ein Resource Server erhält, wenn er fragt, ob ein Token gültig ist.',
	'set.k.tokens.introspection_extended_claims': 'Zusätzliche Claims je Resource Server zurückgeben',
	'set.k.tokens.introspection_extended_claims.desc':
		'Aus: Die Antwort enthält nur die Basis-Claims (active, scope, client_id, sub, exp usw.); Profil und Identity-Mapping des Resource Servers werden nicht verwendet. Ein: Die Claims, die sein Profil erlaubt, werden ergänzt.',
	'set.section.scim': 'SCIM-Provisionierung',
	'set.section.scim.desc':
		'Die Token, mit denen externe Systeme Benutzer über SCIM synchronisieren.',
	'set.section.scim.advanced': 'Die längste erlaubte Gültigkeit',
	'set.k.federation.scim_token_default_expiry': 'Standardgültigkeit von SCIM-Token',
	'set.k.federation.scim_token_default_expiry.desc':
		'Wie lange ein SCIM-Token gilt, wenn es ohne Gültigkeitsdauer erstellt wird. Nie länger als das Maximum. Bereits ausgestellte Token ändern sich nicht.',
	'set.k.federation.scim_token_max_expiry': 'Längste Gültigkeit von SCIM-Token',
	'set.k.federation.scim_token_max_expiry.desc':
		'Ein SCIM-Token kann nicht mit längerer Gültigkeit erstellt werden (höchstens ein Jahr). Bereits ausgestellte Token ändern sich nicht.',
	'set.k.assurance.scim_max_ial': 'Höchste Identitätsvertrauensstufe (IAL), die SCIM angeben darf',
	'set.k.assurance.scim_max_ial.desc':
		'Wie hoch ein externes System über SCIM die Identitätsvertrauensstufe einer Person angeben darf: 1 ist IAL1 (keine Identitätsprüfung), 2 ist IAL2, 3 ist IAL3. Eine Anfrage mit höherer Stufe wird abgelehnt und ändert nichts. Der Wert beginnt bei 1; SCIM kann IAL2 oder IAL3 erst angeben, wenn Sie ihn erhöhen. Bereits erfasste Stufen werden beim Senken nicht entfernt. Nicht begrenzt sind die Angaben von Administratoren, die Stufe für von der Organisation angelegte Konten und CSV-Importe.',
	'set.page.enterprise': 'Unternehmens-SSO (SAML)',
	'set.page.enterprise.desc':
		'Legt fest, ob dieser Mandant überhaupt auf SAML antwortet, wie lange SAML-Assertions und -Anfragen gültig bleiben und womit neue SAML-Anbieter beginnen. Anbieter (IdPs und SPs) werden vorerst noch auf der SAML-Seite der bisherigen Verwaltungsoberfläche registriert.',
	'set.section.samlService': 'SAML-Dienst',
	'set.section.samlService.desc':
		'Wenn ausgeschaltet, weist dieser Mandant jede SAML-Anfrage ab und veröffentlicht seine SAML-Metadaten nicht. Registrierte Anbieter bleiben erhalten.',
	'set.k.federation.saml_enabled': 'SAML verwenden',
	'set.k.federation.saml_enabled.desc':
		'Solange ausgeschaltet, antworten die SAML-IdP- und -SP-Endpunkte und die Metadaten mit 403 (Health-Check und Verwaltungs-API funktionieren weiter). Nach dem Einschalten funktionieren die registrierten Anbieter wie zuvor. Eine Änderung kann etwa eine Minute brauchen, bis sie wirkt.',
	'set.section.samlLifetimes': 'Gültigkeitsdauern',
	'set.section.samlLifetimes.desc': 'Wie lange SAML-Assertions und -Anfragen gültig bleiben.',
	'set.section.samlLifetimes.advanced': 'Gültigkeit der Anfragen',
	'set.k.federation.saml_assertion_ttl': 'Gültigkeit der Assertion',
	'set.k.federation.saml_assertion_ttl.desc':
		'Wie lange eine von Authrim ausgestellte SAML-Assertion gültig ist (60 bis 600 Sekunden). Ein Service Provider mit eigener Gültigkeitsdauer behält sie. Eine Änderung gilt für Assertions, die danach ausgestellt werden.',
	'set.k.federation.saml_request_ttl': 'Gültigkeit der Anfragen',
	'set.k.federation.saml_request_ttl.desc':
		'Wie lange eine SAML-Anmelde- oder -Abmeldeanfrage gültig bleibt (60 bis 600 Sekunden): die älteste Anfrage, die Authrim annimmt, und wie lange gesendete Anfragen aufbewahrt werden, um sie den Antworten zuzuordnen. Eine Änderung gilt für die Aufbewahrung von Anfragen, die danach gestellt werden. Das Alter einer Anfrage wird auch beim Fortsetzen einer laufenden Anmeldung gegen den aktuellen Wert geprüft; ein kürzerer Wert kann daher bereits begonnene Anmeldungen abweisen.',
	'set.section.samlProviderDefaults': 'Standards für neue Anbieter',
	'set.section.samlProviderDefaults.desc':
		'Was ein SAML-Anbieter erhält, wenn er hinzugefügt oder seine Metadaten importiert werden und nichts anderes vorgibt. Bestehende Anbieter ändern sich nicht.',
	'set.section.samlProviderDefaults.advanced': 'Bindings',
	'set.k.federation.saml_nameid_format': 'NameID-Format',
	'set.k.federation.saml_nameid_format.desc':
		'Das NameID-Format, das ein Anbieter erhält, wenn seine Metadaten keines nennen. Ein Anbieterprofil mit eigenem Format (etwa strict) behält es. Persistent gibt jedem Dienst eine eigene Kennung und schützt so die Privatsphäre.',
	'set.k.federation.saml_nameid_format.emailAddress': 'E-Mail-Adresse',
	'set.k.federation.saml_nameid_format.persistent': 'Dauerhafte Kennung',
	'set.k.federation.saml_nameid_format.transient': 'Flüchtige Kennung',
	'set.k.federation.saml_nameid_format.unspecified': 'Nicht festgelegt',
	'set.k.federation.saml_sso_binding': 'Binding der Anmeldung',
	'set.k.federation.saml_sso_binding.desc':
		'Das Binding, über das ein neuer externer Identitätsanbieter angemeldet wird, wenn seine Metadaten beide anbieten oder keines nennen. HTTP-Redirect sendet eine signierte Anfrage, HTTP-POST eine unsignierte.',
	'set.k.federation.saml_sso_binding.HTTP-POST': 'HTTP-POST',
	'set.k.federation.saml_sso_binding.HTTP-Redirect': 'HTTP-Redirect',
	'set.k.federation.saml_slo_binding': 'Binding der Abmeldung',
	'set.k.federation.saml_slo_binding.desc':
		'Das Standard-Binding für Abmeldeanfragen, verwendet, wenn die Metadaten beide anbieten oder keines nennen. Ein Anbieterprofil mit eigenem Binding (das Profil legacy) behält es.',
	'set.k.federation.saml_slo_binding.HTTP-POST': 'HTTP-POST',
	'set.k.federation.saml_slo_binding.HTTP-Redirect': 'HTTP-Redirect',
	'set.k.oauth.id_token_signing_alg.RS256': 'RS256',
	'set.k.oauth.id_token_signing_alg.ES256': 'ES256',
	'set.k.oauth.id_token_signing_alg.PS256': 'PS256',
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
	'settings.inDevelopment': 'In Entwicklung: Eine Änderung wirkt sich noch nicht aus',
	'settings.locked.tenant': 'Durch die Mandanten-Einstellungen festgelegt',
	'settings.badge.locked': 'Gesperrt',
	'settings.badge.here': 'Überschrieben',
	'settings.badge.inDevelopment': 'In Entwicklung',
	'settings.notice.idTokenAlgorithm.title': 'Weicht von OpenID Connect Discovery ab',
	'settings.notice.idTokenAlgorithm.body':
		'Alle ID-Tokens werden nicht mit RS256 signiert und Apps können RS256 nicht wählen, daher bietet das Discovery-Dokument RS256 nicht mehr an, was OpenID Connect Discovery verlangt. Discovery selbst funktioniert weiterhin.',
	'settings.notice.fapi.title': 'FAPI-2.0-Anforderungen gelten',
	'settings.notice.fapi.body':
		'Anfragen, die FAPI 2.0 nicht erlaubt, etwa Autorisierungsanfragen ohne PAR, werden abgelehnt, daher funktionieren Apps ohne FAPI-Unterstützung möglicherweise nicht mehr. Discovery funktioniert weiterhin wie spezifiziert.',
	'settings.notice.exchangeCeilings.title': 'Einigen Apps wird der Token-Austausch verweigert',
	'settings.notice.exchangeCeilings.body':
		'Der Token-Austausch ist ein, Delegation ist aber nicht erlaubt; daher wird Apps im Delegationsmodus (Standard für neue Apps) der Austausch verweigert. Schalten Sie „Delegation zulassen“ ein, damit sie ihn nutzen können.',
	'settings.notice.samlDisabled.title':
		'Apps und externe IdPs, die SAML nutzen, funktionieren nicht mehr',
	'settings.notice.samlDisabled.body':
		'Bei ausgeschaltetem SAML schlagen die Anmeldung von Apps über SAML (Service Provider) und die Anmeldung über externe SAML-Identitätsanbieter fehl. Registrierte Anbieter bleiben erhalten; nach dem Einschalten funktionieren sie wieder.',
	'settings.notice.samlPostBinding.title': 'HTTP-POST sendet die Anmeldeanfrage unsigniert',
	'settings.notice.samlPostBinding.body':
		'Eine Anmeldeanfrage an einen neuen Identitätsanbieter über HTTP-POST trägt keine Signatur. Standard ist HTTP-Redirect, das signiert werden kann. Wählen Sie POST nur, wenn der Identitätsanbieter nichts anderes akzeptiert.',
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
