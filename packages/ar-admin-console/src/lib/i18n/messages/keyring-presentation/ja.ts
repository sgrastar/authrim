/**
 * Keyring as a step-up second factor: the presentation dialog and its enrolment. Spread into
 * `../ja.ts`.
 */
export const jaKeyringPresentation = {
	'kp.starting': '要求を準備しています…',
	'kp.scan': 'Authrim Keyring で QR コードを読み取ってください。',
	'kp.step.scan': 'iPhone の Authrim Keyring で QR コードを読み取ります。',
	'kp.step.code': '承認する内容を確かめ、ここに表示された番号を Keyring に入力します。',
	'kp.step.confirm': 'Face ID かパスコードで確定します。',
	'kp.qr.alt': 'Authrim Keyring 用の QR コード',
	'kp.code.label': 'Keyring に入力する番号',
	'kp.code.note':
		'この番号は QR コードには含まれません。他人から伝えられた番号は入力しないでください。',
	'kp.checking': 'Keyring から応答がありました。確認しています…',
	'kp.expiresIn': '残り {time}',
	'kp.verified': 'Keyring で確認しました。',
	'kp.expired': '時間切れになりました。もう一度始めてください。',
	'kp.failed': 'Keyring で確認できませんでした。もう一度始めてください。',
	'kp.failed.matchCode':
		'Keyring に入力された番号が一致しませんでした。この要求はもう使えません。もう一度始めてください。',
	'kp.failed.notRegistered': 'この Keyring の資格情報は、2 つ目の要素として登録されていません。',
	'kp.failed.alreadyRegistered':
		'この Keyring の資格情報は、すでに登録されているか、以前に登録されたものです。',
	'kp.failed.notActive': 'この Keyring の資格情報は、停止中か失効しています。',
	'kp.failed.wrongAdmin': 'この Keyring の資格情報は、別の管理者のものです。',
	'kp.failed.stale': '前提となる確認の有効期限が切れました。操作をもう一度始めてください。',
	'kp.error': '要求を開始できませんでした。',
	'kp.error.cancelled': '確認がキャンセルされました。',
	'kp.error.notRegistered': '2 つ目の要素として登録された Keyring の資格情報がまだありません。',
	'kp.error.notEligible': '現在、管理者の資格情報は使えません。',
	'kp.error.unavailable': 'この環境では Keyring を使えません。',
	'kp.error.recovery':
		'2 つ目の要素がなく、最初の登録の期間も過ぎています。復旧を申請してください。',
	'kp.browser': 'ブラウザの画面の案内に従って、Authrim Keyring で承認してください。',
	'kp.browser.note':
		'この要求がこのコンソールから出たものかをブラウザが確かめるので、番号の入力は要りません。',
	'kp.openBrowser': 'Keyring で承認する',
	'kp.useQr': 'QR コードで続ける',
	'kp.again': 'もう一度始める',
	'kp.prompt.title': '2 つ目の要素で確認',
	'kp.prompt.desc': 'この操作には、パスキーに加えてもう 1 つの確認が必要です。',
	'kp.prompt.keyringDesc': 'Authrim Keyring から管理者の資格情報を提示します。',
	'kp.prompt.choose': 'どの方法で確認しますか？',
	'kp.prompt.keyring': 'Authrim Keyring',
	'kp.prompt.keyringHint': 'iPhone で QR コードを読み取り、番号を入力します。',
	'kp.prompt.securityKey': 'セキュリティキー',
	'kp.prompt.securityKeyHint': '登録済みの USB か NFC のセキュリティキーを使います。',
	'kp.prompt.continue': '続ける',
	'kp.prompt.other': 'セキュリティキーを使う',
	'kp.enroll.add': 'Keyring を追加',
	'kp.enroll.title': 'Authrim Keyring を 2 つ目の要素として追加',
	'kp.enroll.body':
		'Keyring に発行された管理者の資格情報を提示します。その鍵が 2 つ目の要素として登録されます。',
	'kp.enroll.needCredential':
		'先に、管理者の資格情報を Keyring に発行してください（マイアカウント → Authrim Keyring）。',
	'kp.enroll.added': 'Keyring を 2 つ目の要素として追加しました。',
	'kp.kind.keyring': 'Keyring',
	'kp.kind.securityKey': 'セキュリティキー'
};
