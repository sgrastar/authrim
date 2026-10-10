/**
 * Settings pages: the console's words for Settings API settings (`set.k.<key>`), their pages
 * and sections, and the shared settings-page wording. Spread into `../ja.ts`.
 */
export const jaSettings = {
	'set.page.stayingSignedIn': 'ログイン状態の維持',
	'set.page.stayingSignedIn.desc':
		'一度ログインした利用者と、そのアプリが、どれくらいの間ログインしたままでいられるかを決めます。',
	'set.page.signingKeys': '署名鍵',
	'set.page.signingKeys.desc': 'このテナントがトークンに署名する方法。',
	'set.section.idTokenSigning': 'ID トークンの署名',
	'set.section.idTokenSigning.desc':
		'ID トークンを署名するアルゴリズムと、アプリが自分で選べるかどうか。',

	'set.section.signIn': 'ログインの長さ',
	'set.section.signIn.desc': '利用者が Authrim にログインしたままでいられる時間です。',
	'set.section.signIn.advanced': 'ログイン方法ごとの長さと、指定できる範囲',
	'set.section.appTokens': 'アプリに渡すトークン',
	'set.section.appTokens.desc': 'アプリがログイン状態を使い続けるためのトークンの有効期間です。',
	'set.section.appTokens.advanced': 'ID トークンと、リフレッシュトークンの更新のしかた',
	'set.section.logout': 'ログアウトの通知',
	'set.section.logout.desc':
		'利用者がログアウトしたとき、アプリへ知らせる（バックチャネルログアウト）ときの動きです。',
	'set.section.logout.advanced': '届かなかったときの扱いと、再送',

	'set.k.session.default_ttl': 'ログインを保つ時間',
	'set.k.session.default_ttl.desc':
		'外部の IdP や SAML でのログインなど、方法ごとの時間がないログインで、もう一度ログインが必要になるまでの時間です。パスキーやメールのコードなどの時間は、詳細設定で指定します。',
	'set.k.session.refresh_default': '使っている間はログインを延長する',
	'set.k.session.refresh_default.desc':
		'アプリが延長を求めたとき（/api/sessions/refresh）、その時点から数え直してログインを延ばします。オフにすると延長しません。延長しても、ログインを保つ時間の上限は超えません。',
	'set.k.oauth.sso_enabled': 'アプリ間でログインを共有する（シングルサインオン）',
	'set.k.oauth.sso_enabled.desc':
		'一度ログインすれば、このテナントのほかのアプリにもログインし直さずに入れます。オフにすると、アプリごとにログインが必要です。',
	'set.k.session.ttl.passkey': 'パスキーでログインしたとき',
	'set.k.session.ttl.email_code': 'メールのコードでログインしたとき',
	'set.k.session.ttl.directory_password': 'ディレクトリのパスワードでログインしたとき',
	'set.k.session.ttl.direct_auth': 'Direct Auth でログインしたとき',
	'set.k.session.ttl.did': 'DID でログインしたとき',
	'set.k.session.ttl.guest': 'ゲストとしてログインしたとき',
	'set.k.session.ttl.passkey_registration': 'パスキーを登録した直後',
	'set.k.session.max_ttl': 'ログインを保つ時間の上限',
	'set.k.session.max_ttl.desc':
		'ログインしてから、延長を含めてログインを保てるいちばん長い時間です。方法ごとの時間がこれより長くても、ここで打ち切ります。',

	'set.k.oauth.access_token_expiry': 'アクセストークンの有効期間',
	'set.k.oauth.access_token_expiry.desc':
		'アプリが API を呼ぶときに使うトークンです。短いほど、漏れたときの影響が小さくなります。',
	'set.k.oauth.refresh_token_expiry': 'リフレッシュトークンの有効期間',
	'set.k.oauth.refresh_token_expiry.desc':
		'アプリが、利用者にログインし直してもらわずに、新しいアクセストークンを受け取れる期間です。',
	'set.k.oauth.id_token_expiry': 'ID トークンの有効期間',
	'set.k.oauth.id_token_expiry.desc': 'ログインした人をアプリに伝えるトークンです。',
	'set.k.oauth.refresh_token_rotation': '使うたびに新しいリフレッシュトークンに替える',
	'set.k.oauth.id_token_signing_alg': 'ID トークンの署名アルゴリズム',
	'set.k.oauth.id_token_signing_alg.desc':
		'自分でアルゴリズムを選ばないアプリの ID トークンを、このアルゴリズムで署名します。',
	'set.k.oauth.id_token_signing_alg_client_override': 'アプリごとのアルゴリズムを認める',
	'set.k.oauth.id_token_signing_alg_client_override.desc':
		'オフにすると、すべての ID トークンをテナントのアルゴリズムで署名し、ほかのアルゴリズムでのアプリ登録を拒否します。',
	'set.k.security.fapi_enabled': 'FAPI 2.0 を適用',
	'set.k.security.fapi_enabled.desc':
		'テナントのすべてのアプリに FAPI 2.0 セキュリティプロファイルを適用します。',
	'set.page.appDefaults': 'アプリの既定',
	'set.page.appDefaults.desc':
		'このテナントのすべてのアプリに適用する、認可リクエストとトークンの決まりです。セキュリティの要件は、アプリごとの設定で強めることはできても、緩めることはできません。',
	'set.section.authRequests': '認可リクエスト',
	'set.section.authRequests.desc': 'アプリがログインを求めるときのリクエストに求めることです。',
	'set.section.authRequests.advanced': 'request object の署名と暗号化',
	'set.section.redirectUris': 'リダイレクト URI',
	'set.section.redirectUris.desc': 'ログインのあとにアプリへ戻る先として認めるアドレスです。',
	'set.section.senderConstrained': '送信者に結び付けたトークン',
	'set.section.senderConstrained.desc': 'トークンを、受け取ったアプリの鍵に結び付けます。',
	'set.section.senderConstrained.advanced': 'FAPI での DPoP と nonce',
	'set.section.fapi': 'FAPI',
	'set.section.fapi.desc': '金融グレードのセキュリティプロファイル（FAPI 2.0）です。',
	'set.section.fapi.advanced': 'FAPI の細かな要件',
	'set.section.tokenExchange': 'トークン交換',
	'set.section.tokenExchange.desc':
		'アプリが持っているトークンを、別のトークンに交換することです。',
	'set.section.tokenExchange.advanced': '委任となりすまし',
	'set.k.security.pkce_required': 'PKCE を必須にする',
	'set.k.security.pkce_required.desc':
		'認可コードを使うすべてのリクエストに PKCE（S256）を求めます。アプリ側で必須にもできますが、テナントの必須を外すことはできません。',
	'set.k.security.par_required': 'PAR を必須にする',
	'set.k.security.par_required.desc':
		'認可リクエストを、先にサーバー間で送る（Pushed Authorization Request）ことを求めます。',
	'set.k.oauth.state_required': 'state パラメーターを必須にする',
	'set.k.oauth.state_required.desc': 'CSRF 対策の state を持たない認可リクエストを拒否します。',
	'set.k.security.require_signed_request_object': '署名済みの request object を必須にする',
	'set.k.security.require_signed_request_object.desc':
		'アプリが署名した request object で認可リクエストを送ることを求めます。',
	'set.k.security.require_encrypted_request_object': '暗号化した request object を必須にする',
	'set.k.security.require_encrypted_request_object.desc':
		'このテナントの暗号化用の鍵（JWKS の use=enc）で暗号化した request object で、認可リクエストを送ることを求めます。アプリの対応が必要です。',
	'set.k.security.allow_unsigned_request_object': '署名のない request object を認める（開発用）',
	'set.k.security.allow_unsigned_request_object.desc':
		'本番環境では、この設定にかかわらず認めません。',
	'set.k.security.https_redirect_only': 'リダイレクト URI を HTTPS に限る',
	'set.k.security.https_redirect_only.desc':
		'ネイティブアプリのループバック（localhost など）は http でも使えます。オフにすると、Web アプリもループバックで http を使えます（開発用）。',
	'set.k.security.dpop_bound_access_tokens': 'アクセストークンを DPoP に結び付ける',
	'set.k.security.dpop_bound_access_tokens.desc':
		'トークンを受け取るときに DPoP の証明を求め、漏れたトークンを他人が使えないようにします。アプリの対応が必要です。',
	'set.k.security.dpop_required': 'FAPI での DPoP',
	'set.k.security.dpop_required.desc': 'FAPI を適用しているときに DPoP を求めるかどうかです。',
	'set.k.security.dpop_required.with_fapi': 'FAPI のとき求める',
	'set.k.security.dpop_required.always': '常に求める',
	'set.k.security.dpop_required.never': '求めない',
	'set.k.security.dpop_nonce_enabled': 'DPoP のサーバー nonce を使う',
	'set.k.security.dpop_nonce_enabled.desc':
		'DPoP の証明に、サーバーが渡した nonce を含めることを求め、使い回しを防ぎます。',
	'set.k.security.fapi_strict_dpop': 'DPoP を厳密に検証する',
	'set.k.security.fapi_strict_dpop.desc': '認可リクエストの DPoP 証明が正しくなければ拒否します。',
	'set.k.security.fapi_allow_public_clients': '公開クライアントを認める',
	'set.k.security.fapi_allow_public_clients.desc':
		'FAPI の適用中も、秘密を持たないアプリ（ブラウザやモバイル）を認めます。',
	'set.k.security.fapi_require_private_key_jwt': 'private_key_jwt を必須にする',
	'set.k.security.fapi_require_private_key_jwt.desc':
		'アプリの認証方式を private_key_jwt に限ります。',
	'set.k.security.require_jarm': '認可レスポンスの署名（JARM）を必須にする',
	'set.k.tokens.exchange_enabled': 'トークン交換を使う',
	'set.k.tokens.exchange_enabled.desc':
		'アプリが持っているトークンを、別のトークンに交換できるようにします（RFC 8693）。',
	'set.k.tokens.exchange_delegation_enabled': '委任を認める',
	'set.k.tokens.exchange_delegation_enabled.desc':
		'アプリが利用者に代わって、別のサービス向けのトークンを受け取れるようにします。オフの間は、委任モード（既定）のアプリがトークン交換を断られます。アプリごとの委任モードで、さらに絞れます。',
	'set.k.tokens.exchange_impersonation_enabled': 'なりすましを認める',
	'set.k.tokens.exchange_impersonation_enabled.desc':
		'アプリが、利用者そのものとして振る舞うトークンを受け取れるようにします。なりすましモードのアプリは、オフの間トークン交換を断られます。安全上の影響が大きいので、必要なときだけオンにしてください。',
	'set.page.protection': '攻撃対策',
	'set.page.protection.desc': 'ログインや登録のメールが悪用されるのを防ぐ設定です。',
	'set.section.emailSending': 'メール送信の回数制限',
	'set.section.emailSending.desc':
		'ログインコードなどのメールを、同じ宛先へ続けて送れる回数を制限します。迷惑メールの送信に使われるのを防ぎます。',
	'set.k.rate_limit.email_max_requests': '期間内に送れる回数',
	'set.k.rate_limit.email_max_requests.desc':
		'同じメールアドレス（またはユーザー）へ、ログイン・登録・再認証・ディレクトリ移行のコードを送れる回数です。アカウント探索のコードには別の上限があります。',
	'set.k.rate_limit.email_window': '回数を数える期間',
	'set.k.rate_limit.email_window.desc':
		'上の回数を数える期間です（5 分から 60 分）。この期間が過ぎると、また送れます。',
	'set.section.introspection': 'トークンのイントロスペクション',
	'set.section.introspection.desc':
		'Resource Server がトークンの有効性を問い合わせたときの答えです。',
	'set.k.tokens.introspection_extended_claims': 'Resource Server ごとの追加クレームを返す',
	'set.k.tokens.introspection_extended_claims.desc':
		'オフ: 答えには基本のクレーム（active、scope、client_id、sub、exp など）だけを入れ、Resource Server のプロファイルとアイデンティティマッピングは使いません。オン: Resource Server のプロファイルが許したクレームも加えます。',
	'set.section.scim': 'SCIM プロビジョニング',
	'set.section.scim.desc': 'SCIM で外部のシステムがユーザーを同期するためのトークンです。',
	'set.section.scim.advanced': '有効期限の上限',
	'set.k.federation.scim_token_default_expiry': 'SCIM トークンの既定の有効期限',
	'set.k.federation.scim_token_default_expiry.desc':
		'有効期限を指定せずに SCIM トークンを作ったときの有効期間です。上限より長くはなりません。発行済みのトークンは変わりません。',
	'set.k.federation.scim_token_max_expiry': 'SCIM トークンの有効期限の上限',
	'set.k.federation.scim_token_max_expiry.desc':
		'これより長い有効期限の SCIM トークンは作れません（最長 1 年）。発行済みのトークンは変わりません。',
	'set.page.enterprise': '企業 SSO（SAML）',
	'set.page.enterprise.desc':
		'このテナントが SAML に応じるかどうかと、SAML の有効期間、新しい SAML プロバイダーの既定を決めます。プロバイダー（IdP・SP）の登録は、当面は従来の管理画面の SAML ページで行います。',
	'set.section.samlService': 'SAML の利用',
	'set.section.samlService.desc':
		'オフにすると、このテナントは SAML の要求とメタデータの公開をすべて断ります。登録済みのプロバイダーは消えません。',
	'set.k.federation.saml_enabled': 'SAML を使う',
	'set.k.federation.saml_enabled.desc':
		'オフの間、SAML の IdP・SP のエンドポイントとメタデータは 403 を返します（ヘルスチェックと管理 API は使えます）。オンに戻せば、登録済みのプロバイダーがそのまま使えます。反映まで 1 分ほどかかることがあります。',
	'set.section.samlLifetimes': '有効期間',
	'set.section.samlLifetimes.desc': 'SAML のアサーションとリクエストが有効な時間です。',
	'set.section.samlLifetimes.advanced': 'リクエストの有効期間',
	'set.k.federation.saml_assertion_ttl': 'アサーションの有効期間',
	'set.k.federation.saml_assertion_ttl.desc':
		'Authrim が発行する SAML アサーションが有効な時間です（60〜600 秒）。サービスプロバイダー側に固有の有効期間があるときは、そちらを優先します。変更後に発行するアサーションから反映されます。',
	'set.k.federation.saml_request_ttl': 'リクエストの有効期間',
	'set.k.federation.saml_request_ttl.desc':
		'ログイン・ログアウトの SAML リクエストが有効な時間です（60〜600 秒）。受け付けるリクエストの古さの上限と、送ったリクエストを応答と突き合わせるために保持する時間に使います。新しく出すリクエストの保持時間は変更後から反映されます。受け付けるリクエストの古さは、進行中のログインの再開時にも現在の値で確認するので、短くすると、すでに始まっているログインが断られることがあります。',
	'set.section.samlProviderDefaults': '新しいプロバイダーの既定',
	'set.section.samlProviderDefaults.desc':
		'SAML プロバイダーを追加するときや、メタデータを取り込むときに、ほかに指定がなければ使う値です。既存のプロバイダーは変わりません。',
	'set.section.samlProviderDefaults.advanced': 'バインディング',
	'set.k.federation.saml_nameid_format': 'NameID の形式',
	'set.k.federation.saml_nameid_format.desc':
		'メタデータにも指定がないときの NameID の形式です。プロバイダーのプロファイル（strict など）が形式を決めているときは、そちらを優先します。persistent はサービスごとに別の識別子になるので、利用者のプライバシーを守れます。',
	'set.k.federation.saml_nameid_format.emailAddress': 'メールアドレス',
	'set.k.federation.saml_nameid_format.persistent': '永続的な識別子（persistent）',
	'set.k.federation.saml_nameid_format.transient': '一時的な識別子（transient）',
	'set.k.federation.saml_nameid_format.unspecified': '指定なし（unspecified）',
	'set.k.federation.saml_sso_binding': 'ログインのバインディング',
	'set.k.federation.saml_sso_binding.desc':
		'外部の ID プロバイダーを追加するとき、メタデータが両方のバインディングを示している場合や、指定がない場合に使うバインディングです。HTTP-Redirect は署名付きのリクエストを送り、HTTP-POST は署名なしで送ります。',
	'set.k.federation.saml_sso_binding.HTTP-POST': 'HTTP-POST',
	'set.k.federation.saml_sso_binding.HTTP-Redirect': 'HTTP-Redirect',
	'set.k.federation.saml_slo_binding': 'ログアウトのバインディング',
	'set.k.federation.saml_slo_binding.desc':
		'ログアウト要求のバインディングの既定です。メタデータが両方を示している場合や、指定がない場合に使います。legacy プロファイルのように、プロファイルが決めているときはそちらを優先します。',
	'set.k.federation.saml_slo_binding.HTTP-POST': 'HTTP-POST',
	'set.k.federation.saml_slo_binding.HTTP-Redirect': 'HTTP-Redirect',
	'set.k.oauth.id_token_signing_alg.RS256': 'RS256',
	'set.k.oauth.id_token_signing_alg.ES256': 'ES256',
	'set.k.oauth.id_token_signing_alg.PS256': 'PS256',
	'set.k.oauth.refresh_token_rotation.desc':
		'使ったトークンは無効になります。漏れたトークンの使い回しを防ぐため、オンのままにしておくことをおすすめします。',
	'set.k.oauth.refresh_token_sliding_window_enabled': '使うたびに有効期間を延ばす',
	'set.k.oauth.refresh_token_sliding_window_enabled.desc':
		'リフレッシュトークンを使うたびに、有効期間を数え直します。',
	'set.k.oauth.refresh_token_absolute_expiry_enabled': '延ばしても超えない上限を設ける',
	'set.k.oauth.refresh_token_absolute_expiry_enabled.desc':
		'最初に発行してからの期間に上限を設けます。上限を過ぎると、利用者はログインし直します。',
	'set.k.oauth.refresh_token_absolute_expiry': '上限（最初の発行から）',
	'set.k.oauth.offline_access_required': 'offline_access を求めたアプリにだけ発行する',
	'set.k.oauth.offline_access_required.desc':
		'オフにすると、スコープに関係なくリフレッシュトークンを発行します。',
	'set.k.oauth.refresh_id_token_reissue': '更新のときに ID トークンも発行し直す',

	'set.k.session.backchannel_on_failure': '届かなかったときの扱い',
	'set.k.session.backchannel_on_failure.desc':
		'再送しても通知が届かなかったときに、どうするかです。',
	'set.k.session.backchannel_on_failure.ignore': '何もしない',
	'set.k.session.backchannel_on_failure.log': 'ログに残す',
	'set.k.session.backchannel_on_failure.error': 'エラーにする',
	'set.k.session.backchannel_retry_max_attempts': '再送の回数',
	'set.k.session.backchannel_logout_token_exp': 'ログアウトトークンの有効期間',
	'set.k.session.backchannel_request_timeout_ms': 'アプリの応答を待つ時間',
	'set.k.session.backchannel_retry_initial_delay_ms': '最初の再送までの時間',
	'set.k.session.backchannel_retry_max_delay_ms': '再送の間隔の上限',
	'set.k.session.backchannel_retry_backoff_multiplier': '再送の間隔を延ばす倍率',

	'settings.advanced': '詳細設定',
	'settings.setHere': '上書きしている設定数: {n}',
	'settings.readOnly.title': '閲覧のみ',
	'settings.readOnly.body':
		'この設定を変更する権限がありません。変更が必要なときは、変更できる管理者に依頼してください。',
	'settings.rejected': 'この値は保存できませんでした（{reason}）',
	'settings.partial': '一部の設定を保存できませんでした。印の付いた項目を確認してください。',
	'settings.setHereOption': '上書き設定する',
	'settings.defaultFrom.platform': 'プラットフォーム既定値: {value}',
	'settings.defaultFrom.tenant': 'テナント既定値: {value}',
	'settings.locked.platform': 'プラットフォーム設定による固定値',
	'settings.inDevelopment': '開発中：変更してもまだ効きません',
	'settings.locked.tenant': 'テナント設定による固定値',
	'settings.badge.locked': '上書き不可',
	'settings.badge.here': '上書き中',
	'settings.badge.inDevelopment': '開発中',
	'settings.notice.idTokenAlgorithm.title': 'OpenID Connect Discovery の仕様から外れます',
	'settings.notice.idTokenAlgorithm.body':
		'すべての ID トークンを RS256 以外で署名し、アプリが RS256 を選べないため、Discovery に RS256 が載らなくなります。OpenID Connect Discovery は RS256 を求めています。Discovery そのものは引き続き使えます。',
	'settings.notice.fapi.title': 'FAPI 2.0 の要件が適用されます',
	'settings.notice.fapi.body':
		'PAR を使わない認可要求など、FAPI 2.0 が認めない要求は受け付けなくなります。FAPI に対応していないアプリは動かない場合があります。Discovery は引き続き仕様どおり使えます。',
	'settings.notice.exchangeCeilings.title': 'トークン交換を断られるアプリがあります',
	'settings.notice.exchangeCeilings.body':
		'トークン交換は使えますが、委任を認めていないので、委任モード（新しいアプリの既定）のアプリは断られます。それらのアプリで使うには「委任を認める」をオンにしてください。',
	'settings.notice.samlDisabled.title': 'SAML を使うアプリや外部 IdP が動かなくなります',
	'settings.notice.samlDisabled.body':
		'SAML をオフにすると、SAML でサインインするアプリ（サービスプロバイダー）と、外部の SAML IdP を使ったサインインは、エラーになります。登録済みのプロバイダーは残るので、オンに戻せばそのまま使えます。',
	'settings.notice.samlPostBinding.title': 'HTTP-POST ではログイン要求に署名が付きません',
	'settings.notice.samlPostBinding.body':
		'新しい ID プロバイダーへのログイン要求を HTTP-POST で送ると、リクエストに署名は付きません。署名付きで送れる HTTP-Redirect が既定です。IdP が POST しか受け付けないときだけ選んでください。',
	'settings.value.on': 'オン',
	'settings.value.off': 'オフ',
	'settings.value.empty': '（なし）',
	'settings.conflict.title': 'ほかの管理者が先に保存しました',
	'settings.conflict.body': 'このページを開いた後に、ほかの管理者が次の設定を変更しました。',
	'settings.conflict.reload': '最新の値を読み込む',
	'settings.conflict.reload.desc': 'あなたの変更は破棄されます。',
	'settings.conflict.overwrite': '自分の変更で上書きする',
	'settings.conflict.overwrite.desc': 'あなたが変えた設定だけを、最新の値の上に保存します。',

	'inherit.usingDeployment': 'デプロイ時の設定を使用中',
	'inherit.sourceBuiltIn': 'Authrim',

	'access.none.title': 'このページを見る権限がありません',
	'access.none.body': 'ほかのページを開くか、権限を持つ管理者に依頼してください。',
	'load.error.title': '読み込めませんでした',
	'load.error.body': 'しばらくしてから、もう一度お試しください。',
	'load.retry': 'もう一度読み込む',

	'persona.label': '管理者の種類',
	'persona.platform': 'プラットフォーム管理者',
	'persona.platform.desc': 'インストール全体（すべてのテナントとプラットフォーム）を管理します。',
	'persona.tenant': 'テナント管理者',
	'persona.tenant.desc': '1つのテナントの利用者・アプリ・設定を管理します。',
	'persona.support': 'サポート担当（限定）',
	'persona.support.desc':
		'利用者の手助け（ロックの解除、サインアウト）だけを行います。設定は見えません。',
	'persona.viewer': '閲覧担当（限定）',
	'persona.viewer.desc': '利用者・アプリ・設定を見るだけで、変更はできません。'
} as const;
