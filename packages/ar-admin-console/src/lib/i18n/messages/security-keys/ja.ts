/**
 * My account → Security keys: the step-up security keys (second factors), their recovery, and
 * the recovery requests of the tenant's other admins. Spread into `../ja.ts`.
 */
export const jaSecurityKeys = {
	'sk.title': 'セキュリティキー',
	'sk.info':
		'重要な操作の前に、パスキーに加えて確認に使うキーです。同期されないキー（USB や NFC のセキュリティキーなど）だけを登録できます。ログインには使いません。',
	'sk.add': 'セキュリティキーを追加',
	'sk.addTitle': 'セキュリティキーを追加',
	'sk.addBody': 'あとで見分けられるよう、名前を付けてください。',
	'sk.name': '名前',
	'sk.nameHint': '例：YubiKey（青）',
	'sk.register': 'キーを登録',
	'sk.unnamed': '名前なし',
	'sk.only': '唯一のキー',
	'sk.created': '登録日時',
	'sk.lastUsed': '最終使用',
	'sk.never': '未使用',
	'sk.revoked': '失効',
	'sk.remove': '削除',
	'sk.removeTitle': '「{name}」を削除しますか？',
	'sk.removeBody': 'このキーでは確認できなくなります。',
	'sk.added': 'セキュリティキーを追加しました。',
	'sk.removed': 'セキュリティキーを削除しました。',
	'sk.loadFailed': 'セキュリティキーを読み込めませんでした。',
	'sk.empty': 'セキュリティキーがありません',
	'sk.first.title': '{date} までに最初のキーを登録してください',
	'sk.first.body': 'この期限までは、パスキーの確認だけで最初のキーを登録できます。',
	'sk.recoveryNeeded.title': 'キーの登録には復旧の申請が必要です',
	'sk.recoveryNeeded.body':
		'最初のキーを登録できる期間が過ぎています。新しいキーで復旧を申請すると、24 時間後に完了できます。',
	'sk.recover': '復旧を申請',
	'sk.recoverTitle': 'キーの復旧を申請',
	'sk.recoverBody':
		'新しいキーを登録して申請します。あなたとテナントの管理者全員にメールが届き、24 時間後に完了できます。完了すると、今のキーはすべて失効し、ほかのセッションは終了します。',
	'sk.recoverSubmit': 'キーを登録して申請',
	'sk.recoveryFiled': '復旧を申請しました。',
	'sk.recovery.waiting.title': '復旧の申請中です',
	'sk.recovery.waiting.body':
		'{date} 以降に完了できます。それまでは、あなたかほかの管理者が取り消せます。',
	'sk.recovery.ready.title': '復旧を完了できます',
	'sk.recovery.ready.body': '完了すると、今のキーはすべて失効し、ほかのセッションは終了します。',
	'sk.recovery.complete': '復旧を完了',
	'sk.recovery.completeTitle': '復旧を完了しますか？',
	'sk.recovery.completed': '復旧を完了しました。',
	'sk.recovery.cancel': '申請を取り消す',
	'sk.recovery.cancelTitle': '復旧の申請を取り消しますか？',
	'sk.recovery.cancelBody': '申請したキーは登録されません。',
	'sk.recovery.cancelled': '復旧の申請を取り消しました。',
	'sk.error': 'セキュリティキーを操作できませんでした。もう一度お試しください。',
	'sk.error.notDeviceBound':
		'同期されるキー（パスキー）は使えません。USB や NFC のセキュリティキーを使ってください。',
	'sk.error.inUse': 'このキーはすでに登録されています。',
	'sk.error.minimum': '最後のキーは削除できません。先に別のキーを追加してください。',
	'sk.error.lastResort':
		'管理者があなた 1 人のため、この方法では復旧できません。環境の管理者向けの手順で復旧してください。',
	'sk.error.noEmail':
		'メールを送れないため、復旧を申請できません。メールの配信を設定してください。',
	'sk.error.pending': 'すでに復旧の申請中です。',
	'sk.error.waiting': 'まだ完了できません。{date} 以降にお試しください。',
	'sk.error.cancelled': '確認が取り消されました。',
	'sk.error.windowClosed': '初回登録の期限が過ぎました。復旧を申請してください。',
	'sk.others.title': 'ほかの管理者の復旧の申請',
	'sk.others.info':
		'このテナントの管理者が、セキュリティキーの入れ替えを申請しています。心当たりがなければ取り消してください。',
	'sk.others.admin': '管理者',
	'sk.others.kind': '新しい要素',
	'sk.others.requested': '申請日時',
	'sk.others.notBefore': '完了できる日時',
	'sk.others.cancel': '取り消す',
	'sk.others.cancelTitle': '{email} の申請を取り消しますか？',
	'sk.others.cancelBody':
		'申請したキーは登録されません。本人とテナントの管理者にメールが届きます。',
	'sk.others.cancelled': '申請を取り消しました。',
	'sk.others.noPermission': 'この操作を行う権限がありません。',
	'sk.others.loadFailed': '復旧の申請を読み込めませんでした。'
};
