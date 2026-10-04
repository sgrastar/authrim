/**
 * Settings pages: the console's words for Settings API settings (`set.k.<key>`), their pages
 * and sections, and the shared settings-page wording. Spread into `../ja.ts`.
 */
export const jaSettings = {
	'set.page.stayingSignedIn': 'ログイン状態の維持',
	'set.page.stayingSignedIn.desc':
		'一度ログインした利用者と、そのアプリが、どれくらいの間ログインしたままでいられるかを決めます。',

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
		'ログインしてから、もう一度ログインが必要になるまでの時間です。ログイン方法ごとに変えるときは、詳細設定で指定します。',
	'set.k.session.refresh_default': '使っている間はログインを延長する',
	'set.k.session.refresh_default.desc':
		'操作があるたびに、ログインを保つ時間を数え直します（アプリが個別に指定しないとき）。',
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
	'set.k.session.max_ttl.desc': 'ログインを保つ時間として指定できる、いちばん長い値です。',

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
