/**
 * プラットフォーム → 管理者 → マシン間アクセス（`pages/machine-access`）の文言。
 */
export const jaMachineAccess = {
	'mc.page.desc':
		'Authrim の管理 API を、人ではなく自動化ツールやシステムから使うための登録です。マシンは自分の秘密鍵で署名してサインインし（private_key_jwt）、Authrim には公開鍵だけを預けます。',
	'mc.create': '新規作成',
	'mc.advanced': '詳細設定',

	'mc.list.title': 'マシン',
	'mc.list.noAccess': 'マシン間アクセスを見る権限がありません',
	'mc.list.loadFailed': 'マシンの一覧を読み込めませんでした',
	'mc.list.empty': 'マシンはまだ登録されていません',
	'mc.list.emptyBody':
		'マシン間アクセスは、CI や自動化ツールなど人ではないものに、管理 API を使う権限を渡すための仕組みです。「新規作成」で登録し、公開鍵を追加すると使えるようになります。',
	'mc.list.open': '{name} を開く',
	'mc.list.col.name': '名前 / クライアント ID',
	'mc.list.col.type': '種類',
	'mc.list.col.status': '状態',
	'mc.list.col.keys': '有効な鍵',
	'mc.list.col.updated': '更新',

	'mc.status.active': '有効',
	'mc.status.disabled': '無効',
	'mc.status.deleted': '削除済み',

	'mc.type.automation': '自動化ツール',
	'mc.type.ci': 'CI / デプロイ',
	'mc.type.integration': '外部サービス連携',
	'mc.type.mcp_server': 'MCP サーバー',
	'mc.type.ai_agent': 'AI エージェント',
	'mc.type.internal_service': '内部サービス（プラットフォーム）',
	'mc.type.setup_tool': 'セットアップツール（プラットフォーム）',
	'mc.type.admin_ui_bff': '管理コンソールの中継（プラットフォーム）',

	'mc.reach.none': 'どのテナントにも届かない',
	'mc.reach.noneDesc': '権限を持っていても、どのテナントにも使えません。',
	'mc.reach.tenants': '選んだテナントだけ',
	'mc.reach.tenantsDesc': '下で選んだテナントに限って使えます。',
	'mc.reach.all': 'すべてのテナント',
	'mc.reach.allDesc': 'プラットフォーム全体で使えます。必要なときだけ選んでください。',

	'mc.f.name': '表示名',
	'mc.f.clientId': 'クライアント ID',
	'mc.f.clientIdHint':
		'マシンがサインインするときに名乗る ID です。空白は使えず、あとから変えられません。',
	'mc.f.permissions': '権限',
	'mc.f.permissionsHint':
		'渡す権限を 1 行に 1 つ（例: admin:users:read）。自分が持っている権限だけ渡せます。',
	'mc.f.permissionAdd': '権限を追加',
	'mc.f.reach': '届くテナント',
	'mc.f.reachTenants': 'テナント',
	'mc.f.description': '説明',
	'mc.f.type': '種類',
	'mc.f.typeHint':
		'用途の分類です。プラットフォームの種類は、プラットフォーム管理者だけが作れます。',
	'mc.f.ttl': 'トークンの有効期間',
	'mc.f.ttlUnit': '秒',
	'mc.f.ttlHint': '発行するアクセストークンが使える長さ。最長 {max} 秒です。',

	'mc.perm.space': '権限に空白は使えません',
	'mc.perm.long': '権限が長すぎます',

	'mc.new.title': 'マシンを登録',
	'mc.new.desc':
		'権限やテナントを渡す操作なので、保存するときに追加の本人確認（ステップアップ）を求められることがあります。',
	'mc.new.submit': '登録',
	'mc.new.advancedDesc': '説明、種類、トークンの有効期間。ふつうは変えなくて大丈夫です。',
	'mc.new.nameRequired': '表示名を入力してください',
	'mc.new.clientIdInvalid': 'クライアント ID を空白なしで入力してください',
	'mc.new.clientIdTaken': 'このクライアント ID はすでに使われています',
	'mc.new.reachNoTenants': 'テナントを 1 つ以上選んでください',
	'mc.new.permissionsInvalid': '権限の入力に誤りがあります',
	'mc.new.ttlRange': 'トークンの有効期間は 1〜{max} 秒の整数にしてください',

	'mc.d.back': 'マシン間アクセスへ戻る',
	'mc.d.notFound': 'このマシンは見つかりません',
	'mc.d.loadFailed': 'マシンを読み込めませんでした',
	'mc.d.disabledNote': 'このマシンは無効です。鍵があっても、サインインはできません。',
	'mc.d.deletedNote': 'このマシンは削除されています。この画面では変更も復元もできません。',
	'mc.d.overview': 'マシン',
	'mc.d.status': '状態',
	'mc.d.edit': '編集',
	'mc.d.edit.title': 'マシンの設定',
	'mc.d.edit.save': '保存',
	'mc.d.enable': '有効にする',
	'mc.d.disable': '無効にする',
	'mc.d.disable.title': 'このマシンを無効にしますか',
	'mc.d.disable.body':
		'無効にすると、鍵はそのままでも、このマシンはサインインできなくなります。あとから有効に戻せます（そのときは追加の本人確認を求めます）。',
	'mc.d.advancedDesc': '説明、種類、トークンの有効期間',
	'mc.d.none': 'なし',
	'mc.d.ttlValue': '{seconds} 秒',
	'mc.d.updated': '更新',
	'mc.d.access': '権限と届くテナント',
	'mc.d.accessDesc': 'このマシンが使える権限と、使えるテナントです。',
	'mc.d.access.title': '権限と届くテナントを変更',
	'mc.d.access.note':
		'権限やテナントを渡す変更なので、追加の本人確認（ステップアップ）を求められます。',
	'mc.d.noPermissions': 'まだ権限がありません',

	'mc.key.title': '署名用の鍵',
	'mc.key.desc':
		'マシンは、自分の秘密鍵で署名した証明をつけてサインインします。Authrim が預かるのは公開鍵だけです。鍵を入れ替えるときは、新しい鍵を追加してから古い鍵を取り消してください。',
	'mc.key.add': '鍵を追加',
	'mc.key.empty': '鍵がありません',
	'mc.key.emptyBody': '公開鍵を追加すると、このマシンがサインインできるようになります。',
	'mc.key.col.kid': '鍵 ID (kid)',
	'mc.key.col.alg': 'アルゴリズム',
	'mc.key.col.status': '状態',
	'mc.key.col.expires': '有効期限',
	'mc.key.col.actions': '操作',
	'mc.key.status.active': '有効',
	'mc.key.status.rotating': '入れ替え中',
	'mc.key.status.revoked': '取り消し済み',
	'mc.key.status.expired': '期限切れ',
	'mc.key.status.notYet': '利用開始前',
	'mc.key.noEnd': '期限なし',
	'mc.key.revoke': '取り消す',
	'mc.key.revokeTitle': '鍵 {kid} を取り消しますか',
	'mc.key.revokeBody': 'この鍵ですぐにサインインできなくなります。元に戻せません。',

	'mc.key.new.title': '鍵を追加',
	'mc.key.new.submit': '追加',
	'mc.key.new.note':
		'貼り付けるのは公開鍵だけです。秘密鍵は Authrim に送らず、マシン側で保管してください。鍵は、このマシンの権限とテナントをそのまま使います。',
	'mc.key.kid': '鍵 ID (kid)',
	'mc.key.kidHint': '鍵につける名前です。マシンが署名するときの kid と同じにします。',
	'mc.key.kidRequired': '鍵 ID を入力してください',
	'mc.key.kidTaken': 'このマシンには、同じ鍵 ID がすでにあります',
	'mc.key.jwk': '公開鍵 (JWK)',
	'mc.key.jwkHint':
		'{ "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } の形の JSON を貼り付けます。',
	'mc.key.advancedDesc': 'アルゴリズム、鍵の表示名、有効期限。ふつうは変えなくて大丈夫です。',
	'mc.key.alg': 'アルゴリズム',
	'mc.key.algAuto': '鍵から自動で判断',
	'mc.key.algHint': 'ES256、PS256、RS256 に対応しています。',
	'mc.key.name': '鍵の表示名',
	'mc.key.nameHint': '空にすると、鍵 ID を使います。',
	'mc.key.days': '有効な日数',
	'mc.key.daysUnit': '日',
	'mc.key.daysHint': '空にすると期限はありません。',
	'mc.key.daysInvalid': '日数は 1 以上の整数にしてください',

	'mc.key.jwk.empty': '公開鍵を貼り付けてください',
	'mc.key.jwk.notJson': 'JSON として読めません。{ から } まで、そのまま貼り付けてください',
	'mc.key.jwk.notObject': '鍵は { } で囲んだ JSON のオブジェクトにしてください',
	'mc.key.jwk.private':
		'秘密鍵の項目（d、p、q など）が含まれています。公開鍵だけを貼り付けてください。この鍵は秘密にして、送らないでください',
	'mc.key.jwk.keyType': '対応していない鍵です。EC (P-256) か RSA の公開鍵にしてください',
	'mc.key.jwk.algorithm': '鍵の種類とアルゴリズムが合っていません',
	'mc.key.jwk.use': '署名用 (use が sig) の鍵にしてください',
	'mc.key.jwk.keyOps': '署名や復号などの操作を許す key_ops は使えません',

	'mc.toast.created': '{name} を登録しました。次に公開鍵を追加してください',
	'mc.toast.saved': '保存しました',
	'mc.toast.enabled': '有効にしました',
	'mc.toast.disabled': '無効にしました',
	'mc.toast.keyAdded': '鍵 {kid} を追加しました',
	'mc.toast.keyRevoked': '鍵 {kid} を取り消しました',

	'mc.error.cancelled': '本人確認を取りやめたので、何も送っていません。',
	'mc.error.capabilityOff':
		'プラットフォームの設定で、マシンの鍵や権限を新しく渡すことが止められています。',
	'mc.error.invalid':
		'入力を受け付けられませんでした。渡そうとした権限やテナントが、自分に許されている範囲を超えている可能性があります。値を見直してください。',
	'mc.error.forbidden': 'この操作をする権限がありません。',
	'mc.error.notFound': 'マシンが見つかりません。一覧に戻って確かめてください。',
	'mc.error.conflict':
		'同じ名前がすでにあるか、ほかの人が先に変更しました。読み込み直して確かめてください。',
	'mc.error.generic': '保存できませんでした。もう一度試してください。'
};
