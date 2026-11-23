/**
 * 設定 → 管理者の IP 制限（`pages/team` の IpAllowlist*）の文言。管理画面と Admin API に入れる
 * 管理者の IP アドレスを制限する設定で、エンドユーザーのログインには影響しない。
 */
export const jaIpAllowlist = {
	'ip.page.desc':
		'管理画面と Admin API に入れる IP アドレスを制限します。対象はこのテナントの管理者で、エンドユーザーのログインには影響しません。',
	'ip.add': 'IP を追加',
	'ip.check': 'IP を確認',

	'ip.status.open.title': 'IP 制限はかかっていません',
	'ip.status.open.body':
		'どの IP アドレスからでも管理画面に入れます。有効なエントリを追加すると、その範囲の IP アドレスからしか入れなくなります。',
	'ip.status.active.title': 'IP 制限が有効です',
	'ip.status.active.body':
		'有効なエントリの範囲にある IP アドレスからだけ、管理画面と Admin API に入れます。',
	'ip.you.label': '現在の IP アドレス',
	'ip.you.allowed': '許可されています',
	'ip.you.blocked': '許可されていません',
	'ip.you.unknown': '確認できません',
	'ip.you.none': '現在の IP アドレスを確認できませんでした。',
	'ip.you.ipv6':
		'IPv6 のアドレスです。IPv4 の範囲では許可されません。この画面で追加できるのは IPv4 の範囲だけです。',

	'ip.list.title': '登録した IP アドレス',
	'ip.col.range': 'IP アドレス・範囲',
	'ip.col.size': '対象',
	'ip.col.status': '状態',
	'ip.col.created': '追加日',
	'ip.col.actions': '操作',
	'ip.col.actionsFor': '{range} の操作',
	'ip.size.single': 'アドレス 1 つ',
	'ip.size.range': '{count} 個のアドレス',
	'ip.size.ipv6': 'IPv6',
	'ip.on': '有効',
	'ip.off': '無効',
	'ip.mine': '現在の IP を含む',
	'ip.empty.title': 'まだ登録がありません',
	'ip.empty.body': 'IP アドレスか範囲を追加すると、IP 制限が有効になります。',
	'ip.noAccess': 'IP 制限を見る権限がありません。',
	'ip.loadFailed': 'IP 制限を読み込めませんでした。',

	'ip.action.edit': '編集',
	'ip.action.enable': '有効にする',
	'ip.action.disable': '無効にする',
	'ip.action.delete': '削除',

	'ip.new.title': 'IP を追加',
	'ip.new.submit': '追加',
	'ip.edit.title': 'IP を編集',
	'ip.edit.submit': '保存',
	'ip.field.range': 'IP アドレスまたは範囲',
	'ip.field.rangeHint':
		'IPv4 のアドレス 1 つ（203.0.113.5）か、CIDR の範囲（203.0.113.0/24）を入力します。',
	'ip.field.rangeIpv6':
		'IPv6 の登録は、この画面では変更できません。説明の変更、無効化、削除はできます。',
	'ip.field.description': '説明（任意）',
	'ip.field.descriptionPlaceholder': '例: 本社のネットワーク',
	'ip.useMine': '現在の IP を入れる',
	'ip.preview.single': 'このアドレス 1 つを対象にします。',
	'ip.preview.range': '{first} 〜 {last}（{count} 個のアドレス）を対象にします。',
	'ip.preview.all': 'すべての IPv4 アドレスが対象です。',
	'ip.preview.normalized': '{range} として登録します。',
	'ip.preview.mine': '現在の IP アドレスを含みます。',
	'ip.preview.notMine': '現在の IP アドレスは含みません。',

	'ip.err.empty': 'IP アドレスか範囲を入力してください。',
	'ip.err.address':
		'IPv4 アドレスの形式が正しくありません。0〜255 の数字 4 つを、ドットで区切って入力します。',
	'ip.err.prefix': '範囲の長さは 0〜32 で指定します（例: /24）。',
	'ip.err.ipv6': 'IPv6 は、この画面では追加できません。IPv4 を入力してください。',
	'ip.err.duplicate': 'その範囲はすでに登録されています。',
	'ip.err.invalid': 'サーバーがこの値を受け付けませんでした。入力を確かめてください。',
	'ip.err.forbidden': 'この操作をする権限がありません。',
	'ip.err.notFound': 'このエントリはすでに削除されています。一覧を読み込み直します。',
	'ip.err.generic': '保存できませんでした。もう一度お試しください。',

	'ip.lock.title': '自分が入れなくなります',
	'ip.lock.body':
		'この変更のあと、現在の IP アドレス（{ip}）は許可された範囲に入りません。保存すると、この IP アドレスからは管理画面に入れなくなります。',
	'ip.lock.bodyNoIp':
		'この変更のあと、現在の IP アドレスが許可された範囲に入らなくなるおそれがあります。保存すると、管理画面に入れなくなることがあります。',
	'ip.lock.ipv6': 'IPv6 のアドレスは、IPv4 の範囲では許可できません。',
	'ip.lock.confirm': 'それでも続ける',

	'ip.delete.title': '{range} を削除しますか？',
	'ip.delete.body': 'このエントリを削除します。元に戻せません。',
	'ip.delete.last':
		'有効なエントリがなくなるので、IP 制限は解除され、どの IP アドレスからでも入れるようになります。',
	'ip.delete.confirm': '削除',

	'ip.check.title': 'IP を確認',
	'ip.check.desc': '有効なエントリに照らして、その IP アドレスが管理画面に入れるかを確かめます。',
	'ip.check.field': 'IP アドレス',
	'ip.check.submit': '確認する',
	'ip.check.allowed': '{ip} は許可されます。',
	'ip.check.blocked': '{ip} は許可されません。',
	'ip.check.open': 'IP 制限がかかっていないので、どの IP アドレスも許可されます。',
	'ip.check.invalid': 'IPv4 アドレスを 1 つ入力してください。',

	'ip.toast.added': 'IP を追加しました。',
	'ip.toast.saved': '変更を保存しました。',
	'ip.toast.enabled': '有効にしました。',
	'ip.toast.disabled': '無効にしました。',
	'ip.toast.deleted': '削除しました。'
} as const;
