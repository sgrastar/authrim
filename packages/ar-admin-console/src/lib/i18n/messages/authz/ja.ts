/**
 * エンドユーザーの認可（`pages/authz`、`pages/settings/AuthorizationSettings`）の文言：
 * ユーザー → グループ、アクセス制御 → ロール・アクセス確認、設定 → 認可、ユーザー詳細の
 * 「グループと実効ロール」。管理者のグループとロール（`team`）とは別のものです。
 */
export const jaAuthz = {
	// ---------------------------------------------------------------------------------------
	// 共通
	'az.error.generic': '操作を完了できませんでした。しばらくしてからもう一度お試しください。',
	'az.error.cancelled': '追加認証が取り消されたため、変更していません。',
	'az.error.beyondCeiling':
		'この操作をする権限がありません。あなたが付与できるロールの段階（付与段階）を超えるロールが関わっている可能性があります。',
	'az.error.notFound': '対象が見つかりません。ほかの管理者が削除した可能性があります。',
	'az.error.conflict': '今の状態では変更できません。',
	'az.error.invalid': '入力した値を受け付けられませんでした。',
	'az.error.capability': 'この機能はプラットフォームによって無効にされています。',
	'az.scope.global': 'どこでも',
	'az.scope.tenant': 'このテナント',
	'az.scope.group': 'グループの資源',
	'az.scope.resource': '1 つの資源',
	'az.scope.groupRequired': 'グループを選んでください。',
	'az.scope.resourceInvalid':
		'「種類:ID」または「ID」の形で入力してください（空白とコロン 2 つ以上は使えません）。',
	'az.picker.placeholder': 'メールアドレスまたはユーザー ID',
	'az.picker.typedId': 'このユーザー ID を使う',
	'az.grant.desc':
		'ロールと、それが効く範囲を選びます。選べるのは付与段階 {ceiling} までのロールです。',
	'az.grant.submit': 'ロールを付与',
	'az.grant.role': 'ロール',
	'az.grant.roleRequired': 'ロールを選んでください。',
	'az.grant.roleHidden': '付与段階 {ceiling} を超えるロールは表示していません。',
	'az.grant.scope': '効く範囲',
	'az.grant.scopeHint':
		'「どこでも」が通常です。グループの資源や 1 つの資源に絞ると、その資源を確認するときだけ効きます。',
	'az.grant.scopeGroup': '資源の属するグループ',
	'az.grant.scopeResource': '資源',
	'az.grant.scopeResourceHint':
		'「documents:42」のように種類と ID を、または ID だけを入力します。',

	// ---------------------------------------------------------------------------------------
	// ユーザー → グループ
	'grp.page.desc':
		'このテナントのユーザーのグループです。グループにロールを付けると、グループに入っている人（下のグループの人も）がそのロールを持ちます。',
	'grp.create': 'グループを作成',
	'grp.list.title': 'グループ',
	'grp.list.col.group': 'グループ',
	'grp.list.col.kind': '種類',
	'grp.list.col.members': '人数',
	'grp.list.col.state': '状態',
	'grp.list.open': '{name} を開く',
	'grp.list.empty': 'グループはまだありません',
	'grp.list.emptyBody': '「グループを作成」から作ります。',
	'grp.list.noMatch': '条件に合うグループはありません',
	'grp.list.noAccess': 'グループを見る権限がありません。',
	'grp.list.loadFailed': 'グループを読み込めませんでした。',
	'grp.filter.search': 'キーまたは名前で検索',
	'grp.filter.allKinds': 'すべての種類',
	'grp.filter.allStates': 'すべての状態',
	'grp.kind.static': '通常',
	'grp.kind.dynamic': '動的',
	'grp.kind.scim': 'SCIM',
	'grp.kind.provisioned': 'プロビジョニング',
	'grp.state.active': '有効',
	'grp.state.inactive': '停止中',
	'grp.source.manual': '手動',
	'grp.source.scim': 'SCIM',
	'grp.source.rule': 'プロビジョニング規則',
	'grp.source.dynamic': '動的ルール',
	'grp.source.invitation': '招待',

	'grp.new.title': 'グループを作成',
	'grp.new.submit': '作成',
	'grp.new.kind': '種類',
	'grp.new.kind.static.desc':
		'メンバーを手動で追加します。SCIM・プロビジョニング規則・招待からも入ります。',
	'grp.new.kind.dynamic.desc':
		'ユーザーの属性からメンバーが決まります。ルールは作成後にグループの「動的ルール」で設定します。',
	'grp.new.name': '名前',
	'grp.new.nameRequired': '名前を入力してください。',
	'grp.new.key': 'キー',
	'grp.new.keyHint': '英数字と . _ : - で 128 文字まで（先頭は英数字）。あとから変えられません。',
	'grp.new.dynamicKeyHint':
		'英小文字・数字・_ - で 64 文字まで（先頭は英小文字）。あとから変えられません。',
	'grp.new.keyRequired': 'キーを入力してください。',
	'grp.new.keyInvalid': '英数字と . _ : - で、先頭を英数字にしてください（128 文字まで）。',
	'grp.new.dynamicKeyInvalid':
		'英小文字・数字・_ - で、先頭を英小文字にしてください（64 文字まで）。',
	'grp.new.description': '説明',
	'grp.new.parent': '親グループ',
	'grp.new.parentHint': '親グループのロールは、このグループのメンバーにも効きます。',
	'grp.new.noParent': 'なし（最上位）',
	'grp.toast.created': '{name} を作成しました',
	'grp.toast.saved': 'グループを保存しました',
	'grp.toast.deleted': '{name} を削除しました',

	'grp.d.back': 'グループ一覧',
	'grp.d.profile': 'グループ',
	'grp.d.key': 'キー',
	'grp.d.externalId': '外部 ID',
	'grp.d.created': '作成日時',
	'grp.d.noDescription': '説明はありません',
	'grp.d.edit': '編集',
	'grp.d.notFound': 'このグループは見つかりません',
	'grp.d.loadFailed': 'グループを読み込めませんでした。',
	'grp.d.managedNote':
		'動的グループです。名前・状態・削除は「動的ルール」タブで変えます。メンバーはルールから決まり、手動で追加することもできます。',
	'grp.d.sourcedNote':
		'SCIM またはプロビジョニング規則から作られたグループです。メンバーは元の仕組みで変わります。手動のメンバーも追加できます。',
	'grp.d.delete.title': 'グループを削除',
	'grp.d.delete.desc':
		'メンバーと、このグループに付けたロールも消えます。子グループがあるとき、ほかのグループのロールの範囲がこのグループのときは削除できません。',
	'grp.d.delete.descManaged':
		'動的ルールごと削除します。ほかのグループの親になっているとき、ロールの範囲になっているときは削除できません。',
	'grp.d.delete.action': '削除',
	'grp.d.delete.confirmTitle': '{name} を削除しますか？',
	'grp.d.delete.confirmBody':
		'{count} 人のメンバーとこのグループのロールが外れます。元に戻せません。',
	'grp.edit.title': 'グループを編集',
	'grp.edit.save': '保存',
	'grp.edit.movesRoles':
		'親グループや状態を変えると、このグループと下のグループのメンバーが持つロールが変わります。ロールが付いているときは、ロールの書き込み権限と、そのロールを付与できる段階が必要です。',
	'grp.tab.members': 'メンバー',
	'grp.tab.roles': 'ロール',
	'grp.tab.tree': '階層',
	'grp.tab.rule': '動的ルール',

	'grp.members': 'メンバー',
	'grp.members.desc':
		'出どころごとに 1 行です（同じ人が手動と SCIM の両方で入っていれば 2 行）。「有効」の行だけがロールを与えます。',
	'grp.members.col.user': 'ユーザー',
	'grp.members.col.source': '出どころ',
	'grp.members.col.effective': '今の状態',
	'grp.members.col.ends': '終わり',
	'grp.members.col.actions': '{name} の操作',
	'grp.members.open': '{name} を開く',
	'grp.members.effective': '有効',
	'grp.members.notEffective': '無効',
	'grp.members.noEnd': '期限なし',
	'grp.members.checkedUntil': '次の確認まで',
	'grp.members.empty': 'メンバーはいません',
	'grp.members.loadFailed': 'メンバーを読み込めませんでした。',
	'grp.members.more': 'さらに読み込む',
	'grp.members.dynamicNote':
		'動的ルールの行は、ルールが評価されるたびに更新されます。手動で追加した行は、ルールに関係なく残ります。',
	'grp.members.add': 'メンバーを追加',
	'grp.members.add.title': '{name} にメンバーを追加',
	'grp.members.add.desc': '追加したユーザーは手動のメンバーになります。',
	'grp.members.add.descRoles':
		'このグループ（または親グループ）にはロールが付いています。追加した人はそのロールを持つことになるため、ロールの書き込み権限と、ロールを付与できる段階が必要です。自分自身は追加できません。',
	'grp.members.add.pick': 'ユーザー',
	'grp.members.add.none': '追加するユーザーを選んでください。',
	'grp.members.add.submit': '追加',
	'grp.members.addedSome': '{added} 人を追加しましたが、{name} は追加できませんでした：{reason}',
	'grp.toast.membersAdded': '{count} 人を追加しました',
	'grp.members.remove': 'グループから外す',
	'grp.members.remove.title': '{name} をグループから外しますか？',
	'grp.members.remove.body':
		'手動の所属を終わらせます。SCIM や動的ルールなど、ほかの出どころの所属は残ります。',
	'grp.toast.memberRemoved': '{name} をグループから外しました',

	'grp.roles': 'ロール',
	'grp.roles.desc':
		'このグループと下のグループのメンバー全員が持つロールです。あなたが付与・解除できるのは付与段階 {ceiling} までです。',
	'grp.roles.col.role': 'ロール',
	'grp.roles.col.scope': '効く範囲',
	'grp.roles.col.ends': '終わり',
	'grp.roles.col.actions': '{name} の操作',
	'grp.roles.empty': 'このグループにはロールが付いていません',
	'grp.roles.add': 'ロールを付与',
	'grp.roles.add.title': '{name} にロールを付与',
	'grp.roles.remove': '外す',
	'grp.roles.remove.title': '{role} を外しますか？',
	'grp.roles.remove.body':
		'このグループのメンバーは、ほかの経路で持っていない限りこのロールを失います。',
	'grp.roles.inherited': '親グループから',
	'grp.roles.inheritedNote': '{groups} のロールも、このグループのメンバーに効きます。',
	'grp.toast.roleGranted': 'ロールを付与しました',
	'grp.toast.roleRevoked': '{role} を外しました',

	'grp.tree.parents': '上のグループ',
	'grp.tree.parentsDesc':
		'近い順です。上のグループのロールは、このグループのメンバーにも効きます。',
	'grp.tree.topLevel': '最上位のグループです。',
	'grp.tree.children': '下のグループ',
	'grp.tree.childrenDesc': 'このグループのロールは、下のグループのメンバーにも効きます。',
	'grp.tree.noChildren': '下のグループはありません',

	'grp.rule.title': '動的ルール',
	'grp.rule.desc':
		'ユーザーの属性から、誰がこのグループに入るかを決めます。保存すると、前のルールで入っていた人の所属はすぐに止まり、評価し直されます。',
	'grp.rule.enabled': 'ルールを使う',
	'grp.rule.enabledDesc':
		'オフにすると、ルールによるメンバーはいなくなり、グループは停止中になります。',
	'grp.rule.condition': '条件',
	'grp.rule.noCondition': '条件がありません。ルールで入る人はいません。',
	'grp.rule.notDrawable':
		'このルールは画面の条件エディタでは表示できない形です（ほかのグループの参照など）。そのまま表示しています。',
	'grp.rule.readOnly': '条件を変えるには、ユーザーの書き込み権限が必要です。',
	'grp.rule.selfWritable':
		'{fields} は本人が書き換えられる属性です。ロールが付いているグループ（下のグループを含む）の条件には使えません。',
	'grp.rule.save': 'ルールを保存',
	'grp.rule.saved': 'ルールを保存しました',
	'grp.rule.loadFailed': 'ルールを読み込めませんでした。',
	'grp.rule.missing': 'このグループのルールが見つかりません。',
	'grp.rule.scans': '評価の進み具合',
	'grp.rule.scansDesc':
		'アカウントの格納先ごとの、ルールの評価の進み具合です。今のルールの版は {revision} です。',
	'grp.rule.scans.col.shard': '格納先',
	'grp.rule.scans.col.status': '状態',
	'grp.rule.scans.col.processed': '処理済み',
	'grp.rule.scans.col.failures': '失敗',
	'grp.rule.scans.col.updated': '最終更新',
	'grp.rule.scans.empty': 'まだ評価は始まっていません',
	'grp.rule.scan.completed': '完了',
	'grp.rule.scan.processing': '処理中',
	'grp.rule.scan.pending': '待機中',
	'grp.rule.scan.failed': '失敗',
	'grp.rule.scan.behind': '版 {version} で評価中',

	'grp.error.managed': '動的グループの状態・親・削除は、動的ルールから変えてください。',
	'grp.error.selfWritable':
		'本人が書き換えられる属性で決まるグループが下にあるため、このグループにロールを付けられません。',
	'grp.error.catalogChanged':
		'ほかの操作が先にこの内容を変更しました。読み込み直して確認し、もう一度お試しください。',
	'grp.error.hasDependents':
		'このグループは、ほかのグループの親か、ロールの範囲になっています。先にそちらを変えてください。',
	'grp.error.scimReference': 'SCIM の参照先が SCIM のグループではありません。',
	'grp.error.hasChildren':
		'子グループがあるため削除できません。先に子グループを移すか削除してください。',
	'grp.error.scopedGrant':
		'ほかのグループのロールがこのグループを範囲にしています。先にそのロールを外してください。',
	'grp.error.keyTaken': 'このキーはほかのグループで使われています。',
	'grp.error.changed':
		'グループがほかの操作で変わりました。読み込み直してからもう一度お試しください。',
	'grp.error.otherSource':
		'この所属は SCIM・規則・動的ルール・招待から来ているため、ここでは外せません。元の仕組みで変えてください。',
	'grp.error.accountInactive': 'このアカウントは停止・ロック中か、削除の途中です。',
	'grp.error.parentLoop': '親グループが見つからないか、選ぶと循環になります。',

	// ---------------------------------------------------------------------------------------
	// アクセス制御 → ロール
	'eur.page.desc':
		'このテナントのユーザーに与えるロールです。ロールは「資源:操作」の権限の集まりで、本人に直接、またはグループを通して与えます。',
	'eur.create': 'ロールを作成',
	'eur.ceiling': 'あなたが作成・変更・付与できるのは付与段階 {ceiling} までのロールです。',
	'eur.list.title': 'ロール',
	'eur.list.col.role': 'ロール',
	'eur.list.col.tier': '付与段階',
	'eur.list.col.permissions': '権限',
	'eur.list.col.users': '直接の付与',
	'eur.list.open': '{name} を開く',
	'eur.list.empty': 'ロールはまだありません',
	'eur.list.emptyBody': '「ロールを作成」から作ります。',
	'eur.list.noAccess': 'ロールを見る権限がありません。',
	'eur.list.loadFailed': 'ロールを読み込めませんでした。',
	'eur.kind.system': '既定',
	'eur.tier.short': '段階 {tier}',
	'eur.tier.option': '段階 {tier}',
	'eur.tier.1': 'もっとも弱い。多くの管理者が付与できます。',
	'eur.tier.2': 'テナント管理者が付与できます。',
	'eur.tier.3': 'もっとも強い。スーパー管理者だけが付与できます。',
	'eur.permissions.count': '{count} 個',
	'eur.new.title': '新しいロール',
	'eur.new.submit': '作成',
	'eur.new.name': '名前',
	'eur.new.nameHint':
		'英字で始め、英数字と _ - で 2〜50 文字。あとから変えられません。admin・end_user・ar_ で始まる名前は使えません。',
	'eur.new.nameRequired': '名前を入力してください。',
	'eur.new.nameLength': '2〜50 文字にしてください。',
	'eur.new.nameInvalid': '英字で始め、英数字と _ - だけにしてください。',
	'eur.new.nameReserved': 'この名前は予約されています。',
	'eur.new.description': '説明',
	'eur.new.tier': '付与段階',
	'eur.new.tierInfo':
		'誰がこのロールを付与・解除・変更できるかを決めます。管理者は自分の段階までのロールだけを扱えます。',
	'eur.new.permissions': '権限',
	'eur.new.permissionsHint': '「documents:read」のように「資源:操作」を英小文字で入力します。',
	'eur.new.permissionsNone': '権限を 1 つ以上入力してください。',
	'eur.new.permissionInvalid': '「資源:操作」を英小文字（操作は _ も可）で入力してください。',
	'eur.new.addPermission': '権限を追加',
	'eur.toast.created': '{name} を作成しました',
	'eur.toast.deleted': '{name} を削除しました',
	'eur.d.back': 'ロール一覧',
	'eur.d.profile': 'ロール',
	'eur.d.save': '保存',
	'eur.d.saved': 'ロールを保存しました',
	'eur.d.noChanges': '変更はありません',
	'eur.d.notFound': 'このロールは見つかりません',
	'eur.d.loadFailed': 'ロールを読み込めませんでした。',
	'eur.d.noPermissions': '権限はありません',
	'eur.d.systemNote': '既定のロールです。変更・削除はできません。',
	'eur.d.aboveCeiling':
		'このロールは、あなたが扱える付与段階 {ceiling} を超えています。表示だけできます。',
	'eur.d.holders': '直接付与されているユーザー',
	'eur.d.holders.desc':
		'このロールを本人に直接与えられているユーザーです。グループを通して持っている人は、各グループの「ロール」に表示されます。',
	'eur.d.holders.count': '{count} 件の直接付与があります。',
	'eur.d.holders.col.user': 'ユーザー',
	'eur.d.holders.col.scope': '効く範囲',
	'eur.d.holders.col.ends': '終わり',
	'eur.d.holders.empty': '直接付与されているユーザーはいません',
	'eur.d.holders.loadFailed': '付与を読み込めませんでした。',
	'eur.d.groups': 'グループへの付与',
	'eur.d.groups.desc':
		'このロールを付与されているグループです。そのグループと配下のグループのメンバー全員が持ちます。',
	'eur.d.groups.count': 'グループへの付与は {count} 件です。',
	'eur.d.groups.col.group': 'グループ',
	'eur.d.groups.col.scope': '有効な範囲',
	'eur.d.groups.col.ends': '終了',
	'eur.d.groups.empty': 'グループには付与されていません',
	'eur.d.groups.deleted': '削除されたグループ',
	'eur.d.groups.loadFailed': 'グループへの付与を読み込めませんでした。',
	'eur.d.delete.title': 'ロールを削除',
	'eur.d.delete.desc': '誰にも（グループにも）付与されていないロールだけを削除できます。',
	'eur.d.delete.action': '削除',
	'eur.d.delete.confirmTitle': '{name} を削除しますか？',
	'eur.d.delete.confirmBody': '元に戻せません。',
	'eur.error.inUse':
		'このロールはまだユーザーまたはグループに付与されている(または、ほかの操作で変わった)ため削除できません。先にすべての付与を外してからもう一度お試しください。',
	'eur.error.changed':
		'ロールがほかの操作で変わりました。読み込み直してからもう一度お試しください。',
	'eur.error.inUseGroup':
		'このロールはグループに付与されているか、ほかの操作で変わりました。グループのロールを外してからもう一度お試しください。',
	'eur.error.exists': 'この名前のロール、または同じ付与がすでにあります。',
	'eur.error.system': '既定のロールは変更・削除できません。',

	// ---------------------------------------------------------------------------------------
	// アクセス制御 → アクセス確認
	'acc.page.desc':
		'あるユーザーが、ある操作をしてよいかを確かめます。サービスのバックエンドが Check API に聞いたときと同じ判定を、理由（どのロール・グループ・関係で許可されたか）とともに表示します。何も書き込みません。',
	'acc.noAccess': 'アクセス確認をする権限がありません。',
	'acc.form.title': '確認する内容',
	'acc.form.subject': 'ユーザー',
	'acc.form.subjectRequired': 'ユーザーを選んでください。',
	'acc.form.permission': '権限',
	'acc.form.permissionHint': '「資源:操作」で入力します（例: documents:read）。',
	'acc.form.permissionRequired': '権限を入力してください。',
	'acc.form.permissionInvalid': '「資源:操作」の形で入力してください。',
	'acc.form.resourceId': '資源 ID（任意）',
	'acc.form.resourceIdHint': '1 つの資源について聞くときに入力します。',
	'acc.form.resourceInvalid': '空白とコロンは使えません。',
	'acc.form.resourceGroup': '資源の属するグループ（任意）',
	'acc.form.resourceGroupHint':
		'資源がこのグループのものとして確かめます。「グループの資源」の範囲で付与したロールが効くかを見られます。',
	'acc.form.noGroup': 'なし',
	'acc.form.run': '確認する',
	'acc.result.title': '結果',
	'acc.result.allowed': '許可',
	'acc.result.denied': '拒否',
	'acc.result.asked': '{subject} の {permission}',
	'acc.result.via': '許可の経路',
	'acc.result.viaNone': 'なし',
	'acc.result.time': '判定時間',
	'acc.result.ms': '{ms} ミリ秒',
	'acc.result.reason': '理由',
	'acc.result.trace': '判定の内訳',
	'acc.result.traceEmpty': '一致した規則や関係はありません。',
	'acc.result.rule': '規則',
	'acc.result.path': '経路',
	'acc.via.direct': '直接の権限',
	'acc.via.role': '本人のロール',
	'acc.via.groupRole': 'グループのロール',
	'acc.via.rebac': '関係（ReBAC）',
	'acc.via.idLevel': '資源ごとの権限',
	'acc.via.computed': '計算された関係',

	// ---------------------------------------------------------------------------------------
	// ユーザー詳細 → グループと実効ロール
	'az.user.title': 'グループと実効ロール',
	'az.user.desc':
		'このユーザーが入っているグループと、今持っているロール（本人への付与とグループを通したもの）です。',
	'az.user.loadFailed': '読み込めませんでした。',
	'az.user.groups': '所属グループ',
	'az.user.groups.col.group': 'グループ',
	'az.user.groups.empty': 'どのグループにも入っていません',
	'az.user.groups.ancestors': '上のグループ（ロールが効きます）：',
	'az.user.effective': '実効ロール',
	'az.user.effective.empty': '持っているロールはありません',
	'az.user.roles.col.via': '経路',
	'az.user.via.direct': '直接',
	'az.user.via.group': 'グループ',
	'az.user.via.through': '{group} 経由',
	'az.user.direct': '直接付与したロール',
	'az.user.direct.add': 'ロールを付与',
	'az.user.direct.empty': '直接付与したロールはありません',
	'az.user.direct.removeBody':
		'このユーザーは、グループを通して持っていない限りこのロールを失います。',
	'az.user.toast.granted': 'ロールを付与しました',
	'az.user.toast.revoked': '{role} を外しました',

	// ---------------------------------------------------------------------------------------
	// 設定 → 認可
	'set.page.authorization': '認可',
	'set.page.authorization.desc':
		'エンドユーザーの認可の設定です。ロールとグループに加えて使う仕組み、Check API、動的グループ、トークンに入れるロールの情報を決めます。',
	'set.section.authzEngines': 'ロール以外の判定',
	'set.section.authzEngines.desc':
		'権限の確認で、ロールのあとに属性の規則（ABAC）と関係（ReBAC）も使うかどうかです。',
	'set.section.checkApi': 'Check API',
	'set.section.checkApi.desc':
		'ユーザー本人のアクセストークンで Check API を呼ぶときに、トークンに必要な audience です。',
	'set.section.checkApiPlatform': 'Check API（全テナント共通）',
	'set.section.checkApiPlatform.desc':
		'Check API を使えるようにするかどうかです。テナントが決まる前に判定するため、プラットフォーム全体で設定します。',
	'set.section.dynamicGroups': '動的グループ',
	'set.section.dynamicGroups.desc':
		'動的ルールで決まった所属が、確認し直されないまま有効でいられる長さです。',
	'set.section.rbacClaims': 'トークンに入れるロールの情報',
	'set.section.rbacClaims.desc':
		'ID トークンとアクセストークンに入れるクレームです。すべて外すと入れません。',
	'set.k.feature.enable_abac': '属性の規則（ABAC）',
	'set.k.feature.enable_abac.desc':
		'ロール・資源ごとの権限・関係のあとに、テナントの属性の規則でも判定します。',
	'set.k.feature.enable_rebac': '関係（ReBAC）',
	'set.k.feature.enable_rebac.desc':
		'ユーザーと資源の関係（オーナー、メンバーなど）でも判定します。',
	'set.k.check.audience': '本人のトークンの audience',
	'set.k.check.audience.desc': '空のときはテナントの issuer URL です。',
	'set.k.feature.enable_check_api': 'Check API を使う',
	'set.k.feature.enable_check_api.desc': '/api/check を全テナントで受け付けます。',
	'set.k.groups.dynamic_freshness_seconds': '動的な所属の有効期間（秒）',
	'set.k.groups.dynamic_freshness_seconds.desc':
		'この長さが半分を切ると確認し直して延ばします。確認で結果が古い、または失敗したときは、所属はすぐに止まります。短いほど早く止まりますが、定期処理が増えます。',
	'set.k.tokens.rbac_id_token_claims': 'ID トークン',
	'set.k.tokens.rbac_id_token_claims.desc': 'ID トークンに入れるロールの情報です。',
	'set.k.tokens.rbac_access_token_claims': 'アクセストークン',
	'set.k.tokens.rbac_access_token_claims.desc': 'アクセストークンに入れるロールの情報です。',
	'set.claim.roles.desc': 'ロールの名前（authrim_roles）',
	'set.claim.groups.desc': '所属グループ（authrim_groups）',
	'set.claim.permissions.desc': 'ロールから得た権限（authrim_permissions）',
	'set.claim.scoped_roles.desc': '範囲つきのロール（authrim_scoped_roles）',
	'set.claim.user_type.desc': 'ユーザーの種類',
	'set.claim.relationships_summary.desc': '関係の要約',

	// 設定 → 認可 → Check API キー
	'az.keys.title': 'Check API キー',
	'az.keys.desc':
		'サービスのバックエンドが、このテナントの任意のユーザーについて Check API に聞くためのキーです。キーはアプリのバックエンドの設定で作ります（秘密は作成時に 1 回だけ表示されます）。ここでは無効にできます。',
	'az.keys.col.key': 'キー',
	'az.keys.col.operations': '使える操作',
	'az.keys.col.state': '状態',
	'az.keys.col.created': '作成日時',
	'az.keys.col.actions': '{name} の操作',
	'az.keys.active': '有効',
	'az.keys.revoked': '無効',
	'az.keys.empty': 'Check API キーはありません',
	'az.keys.loadFailed': 'Check API キーを読み込めませんでした。',
	'az.keys.revoke': '無効にする',
	'az.keys.revoke.title': '{name} を無効にしますか？',
	'az.keys.revoke.body':
		'このキーを使うバックエンドは、すぐに Check API を呼べなくなります。元に戻せません。',
	'az.keys.toast.revoked': '{name} を無効にしました',
	'az.picker.groupTypedId': 'このグループ ID を使う',
	'az.picker.groupSearchRefused':
		'グループを検索する権限がないため、入力した ID をそのまま使います',
	'az.picker.searchRefused': 'ユーザーを検索する権限がないため、ユーザー ID として使います',
	'az.picker.groupPlaceholder': 'グループのキーまたは名前',
	'acc.form.rebacRelation': '関係（任意）',
	'acc.form.rebacRelationHint': 'ReBAC で確かめる関係です（例: viewer）。対象と一緒に入力します。',
	'acc.form.rebacObject': '関係の対象（任意）',
	'acc.form.rebacObjectHint': '「種類:ID」で入力します（例: document:42）。',
	'acc.form.rebacIncomplete': '関係と対象は両方入力するか、両方空にしてください。',
	'grp.tree.loadFailed': '下のグループを読み込めませんでした。',
	'grp.edit.parentHint':
		'空にすると最上位になります。自分より下のグループは親にできません（循環になるため拒否されます）。',
	'grp.rule.savedExpiryPending':
		'保存しました。一部のアカウント格納先に届かなかったため、前のルールで入っていた所属の一部が、止まるのを待っている状態です。',
	'az.keys.expired': '期限切れ',
	'set.k.feature.enable_id_level_permissions': '資源ごとの権限',
	'set.k.feature.enable_id_level_permissions.desc':
		'1 つの資源について個別に与えた権限（資源 ID ごとの権限）でも判定します。'
} as const;
