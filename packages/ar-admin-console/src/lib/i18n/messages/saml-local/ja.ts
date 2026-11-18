/**
 * Authentication → SAML, the tenant's own SAML identity: its IdP and SP entity IDs and metadata,
 * the signing certificates of each role and their rollover, the published entity ID style and
 * sign-in address, and the signing-key DR bundle. Spread into `../ja.ts`.
 */
export const jaSamlLocal = {
	// ---- Identity and certificates ----
	'sl.identity.title': 'このテナントの SAML',
	'sl.identity.desc':
		'Authrim が IdP および SP として相手に登録する値です。メタデータ XML を開いて保存し相手に渡すか、メタデータ URL を伝えてください。',
	'sl.role.idp': 'IdP',
	'sl.role.sp': 'SP',
	'sl.role.idp.title': 'Authrim を IdP として登録する',
	'sl.role.sp.title': 'Authrim を SP として登録する',
	'sl.role.idp.hint':
		'外部のサービス（SP）に Authrim をアイデンティティプロバイダーとして登録する値です。',
	'sl.role.sp.hint': '外部の IdP に Authrim をサービスプロバイダーとして登録する値です。',
	'sl.entityId': 'Entity ID',
	'sl.metadataUrl': 'メタデータ URL',
	'sl.openMetadata': 'メタデータ XML を開く',
	'sl.copy': '{name} をコピー',
	'sl.notDeployed': 'SAML はこの環境に配備されていません',

	// ---- Signing certificates ----
	'sl.certs.title': '{role} の署名証明書',
	'sl.certs.desc':
		'メタデータに公開される証明書です。切り替えは「次の証明書を発行」→ 相手が取り込んだら「次の証明書に切り替え」の順に行います。',
	'sl.slot.active': '使用中',
	'sl.slot.next': '次',
	'sl.slot.nextN': '次 {index}',
	'sl.slot.backup': 'バックアップ',
	'sl.slot.active.desc': '今の署名に使われ、メタデータに公開されています。',
	'sl.slot.next.desc': '切り替えを待っている証明書です。',
	'sl.slot.backup.desc': '直前まで使っていた証明書です。相手の移行が済んだら退役できます。',
	'sl.slot.published': 'メタデータに公開中',
	'sl.slot.scheduled': '{date} から公開',
	'sl.slot.withheld': 'メタデータに未公開',
	'sl.slot.withheld.hint':
		'このロールのメタデータ公開設定（metadataCertificatePublication）では、この枠の証明書は公開されません。',
	'sl.slot.defaultKey': '環境の既定鍵で署名しています',
	'sl.slot.empty': 'なし',
	'sl.cert.subject': 'サブジェクト',
	'sl.cert.issuer': '発行者',
	'sl.cert.validFrom': '有効期間の開始',
	'sl.cert.validTo': '有効期間の終了',
	'sl.cert.signature': '署名アルゴリズム',
	'sl.cert.publicKey': '公開鍵',
	'sl.cert.sha1': 'SHA-1 フィンガープリント',
	'sl.cert.sha256': 'SHA-256 フィンガープリント',
	'sl.cert.kid': '鍵 ID',
	'sl.cert.pem': '証明書 (PEM)',
	'sl.cert.copyPem': 'PEM をコピー',
	'sl.cert.downloadPem': 'PEM をダウンロード',
	'sl.cert.expired': '期限切れ',
	'sl.cert.daysLeft': '残り {days} 日',
	'sl.cert.previewFailed': '証明書の内容を読めませんでした。',
	'sl.cert.show': '証明書を表示',
	'sl.cert.detail.title': '{role} の証明書（{slot}）',

	'sl.action.publishNext': '次の証明書を発行',
	'sl.action.promoteNext': '次の証明書に切り替え',
	'sl.action.promoteNext.confirm.title': '{role} の署名を次の証明書に切り替えますか？',
	'sl.action.promoteNext.confirm.body':
		'これ以降の署名は次の証明書で行われ、今の証明書はバックアップとしてメタデータに残ります。相手が次の証明書を取り込み済みであることを確認してください。',
	'sl.action.retireBackup': 'バックアップを退役',
	'sl.action.retireBackup.confirm.title': '{role} のバックアップ証明書を退役しますか？',
	'sl.action.retireBackup.confirm.body':
		'メタデータから外れます。相手がまだこの証明書で検証している場合、その相手との連携は失敗します。',
	'sl.action.deleteNext': '次の証明書を削除',
	'sl.action.deleteNext.confirm.title': '{role} の次の証明書を削除しますか？',
	'sl.action.deleteNext.confirm.body':
		'メタデータから取り下げ、切り替えの候補から外します。鍵の素材自体は削除されません。切り替えはされません。',
	'sl.action.recreateActive': '{role} の使用中の鍵を今すぐ作り直す',
	'sl.action.recreateActive.confirm.title': '{role} の使用中の鍵を作り直しますか？',
	'sl.action.recreateActive.confirm.body':
		'緊急用の操作です。新しい鍵で即座に署名を始めるため、相手が新しいメタデータを取り込むまで、その相手との SAML 連携は失敗します。計画的な切り替えには「次の証明書を発行」を使ってください。',
	'sl.emergency.title': '緊急時の操作',
	'sl.emergency.desc': '鍵の漏えいなど、切り替えを待てないときに使います。',
	'sl.action.done': '署名証明書を更新しました。',

	// ---- Create the next certificate ----
	'sl.new.title': '{role} の次の証明書を発行',
	'sl.new.desc':
		'新しい鍵と自己署名証明書を作り、メタデータに「次」として公開します。署名はまだ切り替わりません。',
	'sl.new.useCurrent': '今の証明書のサブジェクトを使う',
	'sl.new.country': '国 (C)',
	'sl.new.state': '都道府県 (ST)',
	'sl.new.locality': '市区町村 (L)',
	'sl.new.organization': '組織 (O)',
	'sl.new.unit': '部門 (OU)',
	'sl.new.commonName': 'コモンネーム (CN)',
	'sl.new.validFrom': '有効期間の開始',
	'sl.new.validTo': '有効期間の終了',
	'sl.new.validity.hint': '空欄なら今から 1 年間です。',
	'sl.new.keySize': '鍵長 (RSA)',
	'sl.new.san': 'テナントの SAML アドレスの DNS 名を含める',
	'sl.new.san.desc': '証明書の Subject Alternative Name に次の名前を入れます。',
	'sl.new.san.none': '（含めない）',
	'sl.new.san.extra': '追加の DNS 名',
	'sl.new.san.extra.hint': 'カンマまたは空白で区切ります。',
	'sl.new.submit': '発行して公開する',
	'sl.new.validity.error': '終了は開始より後にしてください。',

	// ---- Published entity IDs and sign-in address ----
	'sl.pub.title': '公開する Entity ID とログイン先',
	'sl.pub.desc':
		'相手に登録してもらう Entity ID の形式と、SAML の対話的なログインを始めるアドレスです。変更すると相手の設定も変える必要があります。',
	'sl.pub.style': 'Entity ID の形式',
	'sl.pub.style.metadataUrl': 'メタデータ URL',
	'sl.pub.style.metadataUrl.desc': 'メタデータの URL をそのまま Entity ID にします（既定）。',
	'sl.pub.style.roleUrl': 'ロールの URL',
	'sl.pub.style.roleUrl.desc': '末尾の /metadata を除いた、IdP / SP それぞれの URL にします。',
	'sl.pub.current': '現在',
	'sl.pub.afterSave': '保存後',
	'sl.pub.idpEntityId': 'IdP の Entity ID',
	'sl.pub.spEntityId': 'SP の Entity ID',
	'sl.pub.login': '対話的ログインの送り先',
	'sl.pub.login.tenantHost': 'テナントのホスト',
	'sl.pub.login.tenantHost.desc': 'このテナントのアドレスでログイン画面を開きます。',
	'sl.pub.login.uiBaseUrl': '共通のログイン UI',
	'sl.pub.login.uiBaseUrl.desc':
		'環境共通のログイン UI のアドレスで開きます。テナントの判別はそちらで行われます。',
	'sl.pub.metadata.title': 'メタデータの公開',
	'sl.pub.metadata.signing': 'メタデータ署名',
	'sl.pub.metadata.signing.on': '署名あり',
	'sl.pub.metadata.signing.off': '署名なし',
	'sl.pub.metadata.validUntil': 'validUntil',
	'sl.pub.metadata.validUntil.off': '付けない',
	'sl.pub.metadata.validityDays': '{days} 日間',
	'sl.pub.metadata.cacheDuration': 'キャッシュ期間',
	'sl.pub.metadata.hint':
		'これらは環境の設定です。相手はメタデータを定期的に取り直す前提で、validUntil とキャッシュ期間が決まります。',
	'sl.pub.warning':
		'Entity ID やログイン先を変えると、相手に登録済みの値と一致しなくなります。変更後は相手にメタデータを取り直してもらってください。',
	'sl.pub.save': '保存',
	'sl.pub.saved': '公開設定を保存しました。',

	// ---- DR bundle ----
	'sl.dr.title': '署名鍵の DR バンドル',
	'sl.dr.desc':
		'IdP と SP の署名鍵（秘密鍵を含む）をパスフレーズで暗号化して書き出し、別の環境や再構築後のこのテナントに取り込みます。相手に登録済みの証明書を変えずに復旧できます。',
	'sl.dr.sensitive': '機密',
	'sl.dr.warning':
		'バンドルには秘密鍵が含まれます。オフラインで保管し、意図したテナントにだけ取り込んでください。テナント全体のバックアップにも同じ鍵が含まれます。',
	'sl.dr.passphrase': 'パスフレーズ',
	'sl.dr.passphrase.hint': '{min} 文字以上。バンドルの取り込みにも同じパスフレーズが必要です。',
	'sl.dr.passphrase.confirm': 'パスフレーズ（確認）',
	'sl.dr.passphrase.short': '{min} 文字以上にしてください。',
	'sl.dr.passphrase.mismatch': '確認用のパスフレーズが一致しません。',
	'sl.dr.export': 'バンドルを書き出す',
	'sl.dr.exported': 'DR バンドルをダウンロードしました。',
	'sl.dr.import.title': 'バンドルを取り込む',
	'sl.dr.import.desc':
		'書き出したバンドルの JSON ファイルと、そのときのパスフレーズを指定します。取り込むと、両ロールの署名鍵に加えて、Entity ID の形式と対話的ログインの送り先もバンドル作成時の値に戻ります。',
	'sl.dr.import.file': 'DR バンドル (JSON)',
	'sl.dr.import': '取り込む',
	'sl.dr.import.confirm.title': 'DR バンドルを取り込みますか？',
	'sl.dr.import.confirm.body':
		'このテナントの署名鍵がバンドルの鍵に置き換わり、Entity ID の形式と対話的ログインの送り先もバンドル作成時の値に戻ります。相手に登録済みの証明書や Entity ID と一致しないバンドルを取り込むと、SAML 連携は失敗します。',
	'sl.dr.import.notJson': 'JSON ファイルとして読めませんでした。',
	'sl.dr.imported': 'DR バンドルを取り込みました。署名鍵が置き換わりました。',
	'sl.dr.forbidden': 'DR バンドルの操作には SAML 署名鍵のエクスポート / インポート権限が必要です。',

	// ---- Shared ----
	'sl.load.failed': 'SAML の設定を読み込めませんでした。',
	'sl.forbidden': 'SAML の設定を見る権限がありません。',
	'sl.readOnly': '閲覧のみです。変更には SAML プロバイダーの更新権限が必要です。',
	'sl.cancelled': '操作を取り消しました。'
} as const;
