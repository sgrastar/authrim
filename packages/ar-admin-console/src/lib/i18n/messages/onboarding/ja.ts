/** The first-steps checklist on the overview, and its guides (`#lib/onboarding/checklist`). */
export const jaOnboarding = {
	'ob.title': 'Authrim 101',
	'ob.lead':
		'Authrim を触り始める人のための、入門レッスンです。「案内を始める」を押すと、その画面へ移動し、操作する場所を順に示します。',
	'ob.progress': '{done} / {total} 完了',
	'ob.progressLabel': 'Authrim 101 の進み具合',
	'ob.allDone': 'すべて完了しました。案内は何度でも見直せます。',
	'ob.loadFailed': '進み具合を読み込めませんでした。',
	'ob.saveFailed': '進み具合を保存できませんでした。',
	'ob.status.done': '完了',
	'ob.status.todo': '未完了',
	'ob.status.active': '案内中',
	'ob.start': '案内を始める',
	'ob.startNamed': '案内を始める：{name}',
	'ob.again': 'もう一度見る',
	'ob.againNamed': 'もう一度見る：{name}',
	'ob.stop': '案内をやめる',
	'ob.stopNamed': '案内をやめる：{name}',
	'ob.markDone': '完了にする',
	'ob.markDoneNamed': '完了にする：{name}',
	'ob.markTodo': '未完了に戻す',
	'ob.markTodoNamed': '未完了に戻す：{name}',
	'ob.next': '次へ',
	'ob.back': '戻る',
	'ob.close': '案内を閉じる',
	'ob.stepOf': '{current} / {total}',
	'ob.done.title': '完了しました',
	'ob.done.body': '「{name}」にチェックを付けました。',
	'ob.done.back': '一覧へ戻る',

	'ob.signIn.title': 'まずはログインしてみよう',
	'ob.signIn.desc': 'このテナントのログイン画面を開き、Passkey でログインします。',
	'ob.signIn.s1.title': 'テナントの情報はここにあります',
	'ob.signIn.s1.body':
		'このテナントに関する情報と設定は、「テナント」のカテゴリーにまとまっています。',
	'ob.signIn.s2.title': '基本情報',
	'ob.signIn.s2.body': 'ここから、ログイン画面のアドレスや、公開している各種の情報を確認できます。',
	'ob.signIn.s3.title': 'このテナントのログイン画面',
	'ob.signIn.s3.body':
		'利用者がログインに使うアドレスです。新しいタブで開き、アカウントを登録して Passkey でログインしてみてください。',
	'ob.signIn.s3.action': 'この行のアドレスを開いてください。',

	'ob.theme.title': 'ログイン画面をカスタマイズしてみよう',
	'ob.theme.desc': 'テーマで、ログイン画面の背景画像や文字色を変えます。',
	'ob.theme.nav.title': 'ログイン画面のカスタマイズはここにあります',
	'ob.theme.nav.body':
		'ログイン画面のカスタマイズや、背景・ロゴの変更は、「カスタマイズ」のカテゴリーにあります。',
	'ob.theme.sub.title': 'テーマ',
	'ob.theme.sub.body':
		'ログイン画面の見た目は、テーマとして保存します。作ったテーマは、ここに一覧で並びます。',
	'ob.theme.s1.title': 'テーマを作る',
	'ob.theme.s1.body': 'まずは、テーマを 1 つ作ってみましょう。',
	'ob.theme.s1.action': 'テーマを新しく作るか、一覧のテーマを開いてください。',
	'ob.theme.s2.title': 'レイアウト',
	'ob.theme.s2.body': 'ここでは、画面のレイアウトを決めます。',
	'ob.theme.s3.title': 'デザイン',
	'ob.theme.s3.body': 'ここでは、文字色などの色や書体を変えます。',
	'ob.theme.s4.title': '画像',
	'ob.theme.s4.body': 'ここでは、背景画像やロゴを変えます。',
	'ob.theme.s4.action': 'このタブを開いてください。',
	'ob.theme.s5.title': '背景画像を選ぶ',
	'ob.theme.s5.body': '試しに、プリセットから好きな背景画像を選んでみましょう。',
	'ob.theme.s5.action': 'このボタンからプリセットを開き、画像を 1 つ選んでください。',
	'ob.theme.s5.fallback': '背景画像は、ライトのタブで設定します。このタブを開いてください。',
	'ob.theme.name.title': 'テーマに名前を付ける',
	'ob.theme.name.body': '背景を選べましたね。保存する前に、一覧で見分けられる名前を付けます。',
	'ob.theme.name.action': '名前を入力したら、「次へ」を押してください。',
	'ob.theme.name.fallback':
		'このボタンを押すと、名前を変えられます。変えないときは、そのまま「次へ」を押してください。',
	'ob.theme.s6.title': '保存する',
	'ob.theme.s6.body':
		'ほかの項目も、好きなように変えてみてください。変えた内容はプレビューにすぐ出ます。',
	'ob.theme.s6.action': '終わったら保存を押してください。',
	'ob.theme.apply.title': 'ログイン画面に適用する',
	'ob.theme.apply.body':
		'保存しただけでは、ログイン画面は変わりません。適用すると、このテナントのログイン画面がこのテーマになります。',
	'ob.theme.apply.action': '適用を押し、確認して適用してください。案内はそこで終わりです。',

	'ob.schema.title': 'スキーマを追加、変更してみよう',
	'ob.schema.desc': '利用者について保存する項目（属性）を追加、変更します。',
	'ob.schema.nav.title': '利用者の項目はここにあります',
	'ob.schema.nav.body':
		'利用者について保存する項目（属性）や、権限の設定は、「アクセス制御」のカテゴリーにあります。',
	'ob.schema.sub.title': '属性スキーマ',
	'ob.schema.sub.body': '利用者ごとに保存する項目（属性）は、ここで追加、変更します。',
	'ob.schema.s1.title': '属性を追加する',
	'ob.schema.s1.body':
		'属性は、利用者ごとに保存する項目です。このボタンから新しく追加できます。一覧の属性を開けば、変更もできます。',
	'ob.schema.preset.title': 'プリセットから選ぶ',
	'ob.schema.preset.body':
		'氏名や電話番号など、よく使われる項目は、プリセットからまとめて選べます。',

	'ob.screens.title': '新規登録、ログイン画面をカスタマイズしてみよう',
	'ob.screens.desc': 'スクリーンに入力の部品を置き、入力された値を属性へ保存します。',
	'ob.screens.nav.title': '画面に並べる項目もここで決めます',
	'ob.screens.nav.body':
		'新規登録やログインの画面に並べる入力項目は、「カスタマイズ」のカテゴリーで決めます。',
	'ob.screens.sub.title': 'スクリーン',
	'ob.screens.sub.body': '画面ごとの部品の並びを、スクリーンとして保存します。',
	'ob.screens.row.title': '新規登録のスクリーン',
	'ob.screens.row.body': '新規登録の画面に並ぶ部品は、このスクリーンで決まっています。',
	'ob.screens.row.action': 'この行を開いてください。',
	'ob.screens.row.fallback': '検索や絞り込みで、この行が隠れています。ここで解除してください。',
	'ob.screens.s3.title': '入力の部品',
	'ob.screens.s3.body':
		'ここの部品は、利用者が入力した値を属性スキーマの項目へ保存します。属性スキーマにある属性なら、どれでも保存先に選べます。',
	'ob.screens.s3.action': '部品を 1 つ押して、スクリーンに追加してください。',
	'ob.screens.s4.title': '保存先の項目',
	'ob.screens.s4.body':
		'追加した部品の設定です。保存先の項目で、入力された値を保存する属性を、好きなものに選んでみてください。',
	'ob.screens.s5.title': '保存する',
	'ob.screens.s5.body': '部品の並びや設定は、好きなように変えてみてください。',
	'ob.screens.s5.action': '終わったら保存を押してください。案内はそこで終わりです。',

	'ob.secondFactor.title': '二要素認証を登録してみよう',
	'ob.secondFactor.desc': '重要な操作の前に求められる、2 つ目の認証手段を登録します。',
	'ob.secondFactor.menu.title': 'アカウントのメニュー',
	'ob.secondFactor.menu.body':
		'自分のログイン手段や、2 つ目の認証手段は、右上のアカウントのメニューから「個人設定」を開いて管理します。',
	'ob.secondFactor.menu.action': 'アカウントのアイコンを押してください。',
	'ob.secondFactor.settings.title': '個人設定',
	'ob.secondFactor.settings.body': 'ここから、自分用の設定のページへ移動できます。',
	'ob.secondFactor.settings.action': '「個人設定」を押してください。',
	'ob.secondFactor.settings.fallback':
		'メニューが閉じました。もう一度、アカウントのアイコンを押してください。',
	'ob.secondFactor.keys.title': '2 つ目の認証手段',
	'ob.secondFactor.keys.body':
		'Passkey でのログインに加えて、鍵の交換や管理者の権限の変更のような重要な操作では、もう 1 つの認証手段を求められます。それを、この枠で登録します。セキュリティキー（物理キー）を登録できます。',
	'ob.secondFactor.keys.bodyTotp':
		'Passkey でのログインに加えて、鍵の交換や管理者の権限の変更のような重要な操作では、もう 1 つの認証手段を求められます。それを、この枠で登録します。セキュリティキー（物理キー）のほか、この環境では、スマートフォンの認証アプリ（TOTP）も使えます。',
	'ob.secondFactor.add.title': '登録する',
	'ob.secondFactor.add.body': 'このボタンから、2 つ目の認証手段を登録できます。',
	'ob.secondFactor.add.bodyTotp':
		'このボタンから、セキュリティキーか、認証アプリ（TOTP）のどちらかを選んで登録できます。認証アプリは、表示される QR コードを読み取り、アプリに出る 6 桁の数字を入力します。',
	'ob.secondFactor.add.action': '登録を最後まで進めてください。登録できると、案内は終わります。',
	'ob.secondFactor.keys.bodyBlocked':
		'Passkey でのログインに加えて、鍵の交換や管理者の権限の変更のような重要な操作では、もう 1 つの認証手段を求められます。それを、この枠で管理します。いまは、この枠から新しく登録できない状態です（登録できる期間が過ぎたか、復旧を申請中です）。',
	'ob.secondFactor.add.bodyBlocked':
		'いまは、この枠に登録のボタンが出ていないため、2 つ目の認証手段をここで登録する練習はできません。',
	'ob.secondFactor.add.actionBlocked':
		'案内を閉じてください。この項目は、一覧で「完了にする」を押して、手動で完了にできます。',

	'ob.steps.label': '{name}の手順',
	'ob.steps.progress': '「{name}」の進み具合'
} as const;
