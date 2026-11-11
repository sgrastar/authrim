/** The platform's own method and session profiles, its Default and its switches. */
export const jaPlatformProfiles = {
	'pp.title.method': 'プラットフォームの方式プロフィール',
	'pp.title.session': 'プラットフォームのセッションプロフィール',
	'pp.desc.method':
		'全テナントで使えるサインイン方式のプロフィールと、各テナントの Default の下に重なるプラットフォームの Default を管理します。',
	'pp.desc.session':
		'全テナントで使えるセッションのプロフィールと、各テナントの Default の下に重なるプラットフォームの Default を管理します。',
	'pp.tab.profiles': 'プロフィール',
	'pp.tab.default': 'Default と許可',
	'pp.list.name': 'プロフィール名',
	'pp.list.overriding': 'テナントの写し',
	'pp.list.overridingCount': '{count} テナント',
	'pp.list.updated': '更新日時',
	'pp.list.actions': '{name} の操作',
	'pp.list.open': '{name} を開く',
	'pp.list.create': 'プロフィールを作成',
	'pp.list.empty': 'プラットフォームのプロフィールはまだありません',
	'pp.list.lock': 'ロックする',
	'pp.list.unlock': 'ロックを外す',
	'pp.list.locked': 'ロックしました。テナントの写しは使われなくなります（消えません）。',
	'pp.list.unlocked': 'ロックを外しました。テナントの写しがまた使われます。',
	'pp.list.delete': '削除',
	'pp.list.deleteTitle': '{name} を削除しますか？',
	'pp.list.deleteBody':
		'全テナントで使えなくなります。テナントのサービスフローが使っている間は削除できません。テナントの写しも使われなくなります。',
	'pp.list.deleteSuccess': '削除しました',
	'pp.list.inUse':
		'テナントのサービスフローが使っているため、削除できません。先にフローで別のプロフィールを選んでください。',
	'pp.list.checkIncomplete':
		'使っているテナントを確認しきれなかったため、削除しませんでした。もう一度お試しください。',
	'pp.list.deleting': '削除処理中',
	'pp.list.failed': '操作できませんでした',
	'pp.page.new': '新しいプラットフォームのプロフィール',
	'pp.page.back': 'プラットフォームのプロフィール',
	'pp.page.name': '名前',
	'pp.page.nameHint': 'テナントの一覧にも、この名前で表示されます。',
	'pp.page.nameRequired': '名前を入力してください',
	'pp.page.nameTaken': 'この名前のプラットフォームのプロフィールが既にあります',
	'pp.page.limitReached':
		'プラットフォームのプロフィールの数が上限に達しています。使わないものを削除してください。',
	'pp.page.saved': 'プロフィールを保存しました',
	'pp.page.saveFailed': '保存できませんでした',
	'pp.page.conflict': 'ほかの人が先に変更しました。読み直してください。',
	'pp.page.notFound': 'このプロフィールは見つかりません',
	'pp.page.noAccess': 'プラットフォームのプロフィールを見る権限がありません',
	'pp.page.loadFailed': '読み込めませんでした',
	'pp.page.overriding':
		'{count} テナントが、このプロフィールの写しを持っています。保存しても、写しの値は変わりません（各テナントには「プラットフォームに更新あり」と表示されます）。',
	'pp.page.lockedNote': 'ロック中です。テナントの写しは使われず、テナントは変更できません。',
	'pp.page.deletingNote': '削除処理中のため、変更できません。',
	'pp.default.method': 'プラットフォームの Default（方式）',
	'pp.default.method.desc':
		'テナントが値を持たない設定に使われます。ロック中、またはテナントの変更を許可しないときは、テナントの値に代わって使われます。',
	'pp.default.session': 'プラットフォームの Default（セッション）',
	'pp.switches': 'テナントに許すこと',
	'pp.switches.desc':
		'テナントがプラットフォームのプロフィールを変更すること、独自のプロフィールを作ること、Default を変えることを許すかどうか。オフにすると、全テナントに一斉に効きます。'
};
