/**
 * Sample copy for stories, in every console locale, so the toolbar language switch shows how
 * components cope with long German compounds and right-to-left Arabic. Not used by the app.
 */
import { i18n } from '$lib/i18n/i18n.svelte';
import { pseudoLocalize } from '$lib/i18n/pseudo';
import type { Locale } from '$lib/i18n/locales';

const SAMPLES = {
	create: ['作成', 'Create', 'Erstellen', 'إنشاء'],
	cancel: ['キャンセル', 'Cancel', 'Abbrechen', 'إلغاء'],
	details: ['詳細', 'Details', 'Details', 'التفاصيل'],
	delete: ['削除', 'Delete', 'Löschen', 'حذف'],
	save: ['変更を保存', 'Save changes', 'Änderungen speichern', 'حفظ التغييرات'],
	saving: ['保存中…', 'Saving…', 'Wird gespeichert…', 'جارٍ الحفظ…'],
	run: ['実行', 'Run', 'Ausführen', 'تشغيل'],
	docs: ['ドキュメント', 'Documentation', 'Dokumentation', 'الوثائق'],
	notifications: ['通知', 'Notifications', 'Benachrichtigungen', 'الإشعارات'],
	settings: ['設定', 'Settings', 'Einstellungen', 'الإعدادات'],
	close: ['閉じる', 'Close', 'Schließen', 'إغلاق'],
	moveUp: ['上へ移動', 'Move up', 'Nach oben', 'نقل لأعلى'],
	moveDown: ['下へ移動', 'Move down', 'Nach unten', 'نقل لأسفل'],
	rowActions: ['行の操作', 'Row actions', 'Zeilenaktionen', 'إجراءات الصف'],

	enableFlow: [
		'このフローを有効にする',
		'Enable this flow',
		'Diesen Ablauf aktivieren',
		'تفعيل هذا التدفق'
	],
	appliesNow: [
		'切り替えた時点で反映されます。',
		'Takes effect as soon as you switch it.',
		'Wird sofort beim Umschalten wirksam.',
		'يسري فور التبديل.'
	],
	requireMfa: [
		'MFA を必須にする',
		'Require MFA',
		'MFA verpflichtend machen',
		'اشتراط المصادقة متعددة العوامل'
	],
	loginMethods: ['ログイン方法', 'Sign-in methods', 'Anmeldemethoden', 'طرق تسجيل الدخول'],
	notUntilSaved: [
		'保存するまで反映されません。',
		'Nothing changes until you save.',
		'Erst nach dem Speichern wirksam.',
		'لن يتغير شيء حتى تحفظ.'
	],
	passkey: ['パスキー', 'Passkey', 'Passkey', 'مفتاح المرور'],
	passkeyDesc: [
		'登録済みのパスキーでログインします',
		'Sign in with a registered passkey',
		'Anmeldung mit einem registrierten Passkey',
		'تسجيل الدخول بمفتاح مرور مسجّل'
	],
	emailCode: [
		'メールのワンタイムコード',
		'Email one-time code',
		'Einmalcode per E-Mail',
		'رمز لمرة واحدة عبر البريد'
	],
	sms: [
		'SMS（このテナントでは使えません）',
		'SMS (unavailable in this tenant)',
		'SMS (in diesem Mandanten nicht verfügbar)',
		'رسالة نصية (غير متاحة لهذا المستأجر)'
	],
	state: ['状態', 'Status', 'Status', 'الحالة'],

	groupBasic: ['基本', 'Basic', 'Grundlegend', 'أساسي'],
	groupStronger: ['より安全', 'Stronger', 'Sicherer', 'أقوى'],
	storedIn: ['保存先の項目', 'Stored in', 'Gespeichert in', 'يُحفظ في'],
	displayName: ['表示名', 'Display name', 'Anzeigename', 'الاسم المعروض'],
	contactEmail: [
		'連絡先メールアドレス',
		'Contact email',
		'Kontakt-E-Mail',
		'البريد الإلكتروني للتواصل'
	],
	emailPlaceholder: [
		'security@example.com',
		'security@example.com',
		'security@example.com',
		'security@example.com'
	],
	appDescription: ['アプリの説明', 'App description', 'App-Beschreibung', 'وصف التطبيق'],
	appDescriptionValue: [
		'社員向けの経費精算アプリ。ログイン時に部署を確認します。',
		'Expense app for employees. Checks the department at sign-in.',
		'Spesen-App für Mitarbeitende. Prüft beim Anmelden die Abteilung.',
		'تطبيق المصروفات للموظفين. يتحقق من القسم عند تسجيل الدخول.'
	],
	appDescriptionHint: [
		'同意画面に表示されます。',
		'Shown on the consent screen.',
		'Wird auf dem Einwilligungsbildschirm angezeigt.',
		'يظهر في شاشة الموافقة.'
	],
	displayNameHint: [
		'ログイン画面に表示されます',
		'Shown on the sign-in page',
		'Wird auf der Anmeldeseite angezeigt',
		'يظهر في صفحة تسجيل الدخول'
	],
	redirectUri: ['リダイレクト URI', 'Redirect URI', 'Weiterleitungs-URI', 'عنوان إعادة التوجيه'],
	redirectError: [
		'https:// で始まる URL を入力してください',
		'Enter a URL that starts with https://',
		'Geben Sie eine URL ein, die mit https:// beginnt',
		'أدخل عنوانًا يبدأ بـ https://'
	],
	tenantName: ['テナント名', 'Tenant name', 'Mandantenname', 'اسم المستأجر'],
	tenantId: ['テナント ID', 'Tenant ID', 'Mandanten-ID', 'معرّف المستأجر'],
	tenantIdHint: [
		'URL に使われます。後から変更できません。',
		'Used in URLs. Cannot be changed later.',
		'Wird in URLs verwendet und kann später nicht geändert werden.',
		'يُستخدم في العناوين ولا يمكن تغييره لاحقًا.'
	],

	enabled: ['有効', 'Enabled', 'Aktiviert', 'مفعّل'],
	disabled: ['無効', 'Disabled', 'Deaktiviert', 'معطّل'],
	missing: ['未設定 2 件', '2 not set', '2 nicht konfiguriert', 'عنصران غير مهيئين'],
	failed: ['失敗', 'Failed', 'Fehlgeschlagen', 'فشل'],
	preview: ['プレビュー', 'Preview', 'Vorschau', 'معاينة'],

	flowsTitle: ['サービスフロー', 'Service flows', 'Dienstabläufe', 'تدفقات الخدمة'],
	flowsDesc: [
		'ログインや連携の流れを、接続ごとにまとめて設定します。',
		'Configure sign-in and integration flows per connection.',
		'Anmelde- und Integrationsabläufe pro Verbindung konfigurieren.',
		'اضبط تدفقات تسجيل الدخول والتكامل لكل اتصال.'
	],
	newFlow: ['新しいフロー', 'New flow', 'Neuer Ablauf', 'تدفق جديد'],
	colFlow: ['フロー', 'Flow', 'Ablauf', 'التدفق'],
	colProtocol: ['プロトコル', 'Protocol', 'Protokoll', 'البروتوكول'],
	colStatus: ['状態', 'Status', 'Status', 'الحالة'],
	colSetup: ['設定状況', 'Setup', 'Einrichtung', 'الإعداد'],
	flowLogin: ['ログイン', 'Sign-in', 'Anmeldung', 'تسجيل الدخول'],
	flowSlack: [
		'Slack へのプロビジョニング',
		'Provisioning to Slack',
		'Benutzerbereitstellung für Slack',
		'التزويد إلى Slack'
	],
	flowVc: [
		'社員証の発行',
		'Employee credential issuance',
		'Mitarbeiternachweisausstellung',
		'إصدار بطاقة الموظف'
	],
	configured: ['設定済み', 'Configured', 'Konfiguriert', 'مهيأ'],
	invitations: ['招待', 'Invitations', 'Einladungen', 'الدعوات'],
	noInvitations: [
		'招待はまだありません',
		'No invitations yet',
		'Noch keine Einladungen',
		'لا توجد دعوات بعد'
	],
	noInvitationsDesc: [
		'管理者を招待すると、ここに表示されます。',
		'Invited administrators appear here.',
		'Eingeladene Administratoren erscheinen hier.',
		'يظهر المسؤولون المدعوون هنا.'
	],
	invite: ['招待する', 'Invite', 'Einladen', 'دعوة'],

	signingKeys: ['署名鍵', 'Signing keys', 'Signaturschlüssel', 'مفاتيح التوقيع'],
	signingKeysDesc: [
		'トークンの署名に使う鍵です。',
		'Keys used to sign tokens.',
		'Schlüssel zum Signieren von Token.',
		'المفاتيح المستخدمة لتوقيع الرموز.'
	],
	rotate: ['ローテーション', 'Rotate', 'Rotieren', 'تدوير'],
	keyExpires: [
		'現在の鍵は 42 日後に失効します。',
		'The current key expires in 42 days.',
		'Der aktuelle Schlüssel läuft in 42 Tagen ab.',
		'ينتهي المفتاح الحالي خلال 42 يومًا.'
	],
	lastRotation: [
		'最終ローテーション: 2026-08-14',
		'Last rotated: 2026-08-14',
		'Zuletzt rotiert: 2026-08-14',
		'آخر تدوير: 2026-08-14'
	],

	previewBody: [
		'この機能は開発中です。',
		'This feature is in development.',
		'Diese Funktion befindet sich in Entwicklung.',
		'هذه الميزة قيد التطوير.'
	],
	requiredTitle: [
		'必須の設定が残っています',
		'Required settings remain',
		'Erforderliche Einstellungen fehlen',
		'إعدادات مطلوبة متبقية'
	],
	requiredBody: [
		'SCIM トークンを設定すると有効にできます。',
		'Set a SCIM token to enable this flow.',
		'Legen Sie ein SCIM-Token fest, um den Ablauf zu aktivieren.',
		'اضبط رمز SCIM لتفعيل هذا التدفق.'
	],
	authFailed: [
		'認証に失敗しました。もう一度お試しください。',
		'Authentication failed. Please try again.',
		'Authentifizierung fehlgeschlagen. Bitte erneut versuchen.',
		'فشلت المصادقة. يرجى المحاولة مرة أخرى.'
	],

	retireTitle: [
		'サービスグループへ統合予定',
		'To be folded into service groups',
		'Wird in Dienstgruppen überführt',
		'سيُدمج في مجموعات الخدمة'
	],
	retireDesc: [
		'下の 2 つが解消したらナビから削除します。',
		'Removed from navigation once the two items below are resolved.',
		'Wird aus der Navigation entfernt, sobald die beiden Punkte unten gelöst sind.',
		'سيُزال من التنقل بعد حل البندين أدناه.'
	],
	retire1t: ['ロールのスコープ', 'Role scope', 'Rollenbereich', 'نطاق الدور'],
	retire1d: [
		'グループを対象にできるスコープが要ります。',
		'A scope that can target a group is needed.',
		'Ein Bereich, der eine Gruppe adressieren kann, wird benötigt.',
		'يلزم نطاق يمكنه استهداف مجموعة.'
	],
	retire2t: ['主たる所属', 'Primary membership', 'Primärmitgliedschaft', 'العضوية الأساسية'],
	retire2d: [
		'どれが主かを決める仕組みが要ります。',
		'Something has to decide which group is primary.',
		'Es muss festgelegt werden, welche Gruppe primär ist.',
		'يجب تحديد المجموعة الأساسية.'
	],
	retireFoot: [
		'階層とロール付与はサービスグループで既に置き換えられます。',
		'Hierarchy and role granting are already covered by service groups.',
		'Hierarchie und Rollenvergabe decken Dienstgruppen bereits ab.',
		'التسلسل الهرمي ومنح الأدوار مغطيان بالفعل بمجموعات الخدمة.'
	],

	emptyTitle: [
		'まだ何もありません',
		'Nothing here yet',
		'Noch nichts vorhanden',
		'لا يوجد شيء بعد'
	],
	emptyDesc: [
		'最初の項目を作成してください。',
		'Create the first item to get started.',
		'Erstellen Sie den ersten Eintrag.',
		'أنشئ العنصر الأول للبدء.'
	],
	loading: ['読み込み中', 'Loading', 'Wird geladen', 'جارٍ التحميل'],
	createTenant: ['テナントを作成', 'Create tenant', 'Mandanten erstellen', 'إنشاء مستأجر'],

	closeNodeTitle: [
		'このノードを閉じますか？',
		'Close this step?',
		'Diesen Schritt schließen?',
		'هل تريد إغلاق هذه الخطوة؟'
	],
	closeNodeBody: [
		'入力した設定は失われます。',
		'The settings you entered will be lost.',
		'Die eingegebenen Einstellungen gehen verloren.',
		'ستفقد الإعدادات التي أدخلتها.'
	],
	deleteTenant: ['テナントを削除', 'Delete tenant', 'Mandanten löschen', 'حذف المستأجر'],
	deleteTenantDesc: [
		'ユーザー・接続・監査ログを含むすべてのデータが削除されます。元に戻せません。',
		'Deletes all data, including users, connections and audit logs. This cannot be undone.',
		'Löscht alle Daten einschließlich Benutzer, Verbindungen und Prüfprotokolle. Dies kann nicht rückgängig gemacht werden.',
		'يحذف جميع البيانات بما فيها المستخدمون والاتصالات وسجلات التدقيق. لا يمكن التراجع عن ذلك.'
	],
	deleteConfirmTitle: [
		'Acme Corporation を削除しますか？',
		'Delete Acme Corporation?',
		'Acme Corporation löschen?',
		'هل تريد حذف Acme Corporation؟'
	],
	deleteConfirmBody: [
		'この操作は取り消せません。',
		'This cannot be undone.',
		'Dies kann nicht rückgängig gemacht werden.',
		'لا يمكن التراجع عن هذا الإجراء.'
	],

	authMethodsTitle: [
		'認証方法',
		'Authentication methods',
		'Authentifizierungsmethoden',
		'طرق المصادقة'
	],
	authMethodsDesc: [
		'このテナントで使えるログイン方法を選びます。',
		'Choose how people can sign in to this tenant.',
		'Legen Sie fest, wie sich Personen bei diesem Mandanten anmelden können.',
		'اختر طرق تسجيل الدخول المتاحة لهذا المستأجر.'
	],
	usersTitle: ['ユーザー', 'Users', 'Benutzer', 'المستخدمون'],
	usersDesc: [
		'このテナントのアカウントを検索・管理します。',
		'Find and manage the accounts in this tenant.',
		'Konten dieses Mandanten suchen und verwalten.',
		'ابحث عن حسابات هذا المستأجر وأدِرها.'
	],
	createUser: ['ユーザーを作成', 'Create user', 'Benutzer erstellen', 'إنشاء مستخدم'],
	table: ['表', 'Table', 'Tabelle', 'جدول'],
	samlMetadata: [
		'SAML メタデータ（JSON）',
		'SAML metadata (JSON)',
		'SAML-Metadaten (JSON)',
		'بيانات SAML الوصفية (JSON)'
	],
	jsonHint: [
		'IdP から受け取ったメタデータを貼り付けます。',
		'Paste the metadata you received from the IdP.',
		'Fügen Sie die vom IdP erhaltenen Metadaten ein.',
		'الصق البيانات الوصفية التي تلقيتها من موفر الهوية.'
	],
	importUsers: [
		'ユーザーの一括インポート',
		'Bulk user import',
		'Massenimport von Benutzern',
		'استيراد المستخدمين دفعة واحدة'
	],
	certificates: ['証明書', 'Certificates', 'Zertifikate', 'الشهادات'],
	logo: ['ロゴ', 'Logo', 'Logo', 'الشعار'],
	background: ['背景画像', 'Background image', 'Hintergrundbild', 'صورة الخلفية'],
	uploading: [
		'users.csv をアップロード中',
		'Uploading users.csv',
		'users.csv wird hochgeladen',
		'جارٍ رفع users.csv'
	],
	importing: ['インポート中', 'Importing', 'Wird importiert', 'جارٍ الاستيراد'],
	preparing: ['準備中', 'Preparing', 'Wird vorbereitet', 'جارٍ التحضير'],
	savedToast: [
		'設定を保存しました。',
		'Settings saved.',
		'Einstellungen gespeichert.',
		'تم حفظ الإعدادات.'
	],
	errorToast: [
		'署名鍵をローテーションできませんでした。',
		'Could not rotate the signing key.',
		'Der Signaturschlüssel konnte nicht rotiert werden.',
		'تعذّر تدوير مفتاح التوقيع.'
	],
	warningToast: [
		'残り 3 日で証明書が失効します。',
		'The certificate expires in 3 days.',
		'Das Zertifikat läuft in 3 Tagen ab.',
		'تنتهي صلاحية الشهادة خلال 3 أيام.'
	],
	infoToast: [
		'インポートをバックグラウンドで開始しました。',
		'Import started in the background.',
		'Import im Hintergrund gestartet.',
		'بدأ الاستيراد في الخلفية.'
	],
	showSuccess: ['成功', 'Success', 'Erfolg', 'نجاح'],
	showError: ['エラー', 'Error', 'Fehler', 'خطأ'],
	showWarning: ['警告', 'Warning', 'Warnung', 'تحذير'],
	showInfo: ['お知らせ', 'Info', 'Info', 'معلومة'],
	dismissAll: ['すべて閉じる', 'Dismiss all', 'Alle schließen', 'إغلاق الكل'],
	colName: ['名前', 'Name', 'Name', 'الاسم'],
	colEmail: ['メール', 'Email', 'E-Mail', 'البريد'],
	colRole: ['ロール', 'Role', 'Rolle', 'الدور'],
	colLastLogin: ['最終ログイン', 'Last sign-in', 'Letzte Anmeldung', 'آخر تسجيل دخول'],
	suspend: ['停止', 'Suspend', 'Sperren', 'إيقاف'],
	flowName: [
		'Slack へのログイン',
		'Sign-in to Slack',
		'Anmeldung bei Slack',
		'تسجيل الدخول إلى Slack'
	],
	flowDetail: ['OIDC', 'OIDC', 'OIDC', 'OIDC'],
	slackTitle: ['Slack', 'Slack', 'Slack', 'Slack'],
	slackDetail: ['リライングパーティ', 'Relying party', 'Vertrauende Partei', 'الطرف المعتمد'],
	usersDb: ['ユーザー', 'Users', 'Benutzer', 'المستخدمون'],
	usersDbDetail: ['Authrim のアカウント', 'Authrim accounts', 'Authrim-Konten', 'حسابات Authrim'],
	tabOverview: ['概要', 'Overview', 'Übersicht', 'نظرة عامة'],
	tabAuthMethods: ['認証手段', 'Authentication methods', 'Anmeldeverfahren', 'طرق المصادقة'],
	tabSessions: ['セッション', 'Sessions', 'Sitzungen', 'الجلسات'],
	tabAudit: ['監査ログ', 'Audit log', 'Prüfprotokoll', 'سجل التدقيق'],
	tabEmails: ['メール', 'Emails', 'E-Mails', 'رسائل البريد'],
	tabSupport: [
		'サポートと保持',
		'Support & retention',
		'Support & Aufbewahrung',
		'الدعم والاحتفاظ'
	],
	tabRoles: ['ロール', 'Roles', 'Rollen', 'الأدوار'],
	tabConsents: ['同意', 'Consents', 'Einwilligungen', 'الموافقات'],
	accountInfo: ['アカウント情報', 'Account information', 'Kontoinformationen', 'معلومات الحساب'],
	userInfo: ['ユーザー情報', 'User information', 'Benutzerinformationen', 'معلومات المستخدم'],
	fieldName: ['名前', 'Name', 'Name', 'الاسم'],
	fieldGiven: ['名', 'Given name', 'Vorname', 'الاسم الأول'],
	fieldFamily: ['姓', 'Family name', 'Nachname', 'اسم العائلة'],
	fieldNickname: ['ニックネーム', 'Nickname', 'Spitzname', 'الاسم المستعار'],
	fieldUsername: [
		'ユーザー名',
		'Preferred username',
		'Bevorzugter Benutzername',
		'اسم المستخدم المفضل'
	],
	fieldPhone: ['電話番号', 'Phone number', 'Telefonnummer', 'رقم الهاتف'],
	phoneVerified: [
		'電話番号を確認済みにする',
		'Phone number verified',
		'Telefonnummer bestätigt',
		'تم التحقق من رقم الهاتف'
	],
	phoneVerifiedDesc: [
		'この利用者の電話番号を確認済みとして扱います。',
		'Treat this user’s phone number as verified.',
		'Die Telefonnummer dieser Person gilt als bestätigt.',
		'اعتبار رقم هاتف هذا المستخدم مُتحقَّقًا منه.'
	],
	userId: ['ユーザー ID', 'User ID', 'Benutzer-ID', 'معرّف المستخدم'],
	emailVerified: ['メール確認', 'Email verified', 'E-Mail bestätigt', 'تأكيد البريد'],
	yes: ['済み', 'Yes', 'Ja', 'نعم'],
	permTitle: ['権限', 'Permissions', 'Berechtigungen', 'الأذونات'],
	permHint: [
		'このロールに与える権限を選びます。1 つ以上が必要です。',
		'Choose what this role may do. At least one is required.',
		'Wählen Sie, was diese Rolle darf. Mindestens eine Berechtigung ist nötig.',
		'اختر ما يُسمح لهذا الدور به. يلزم إذن واحد على الأقل.'
	],
	grpConsole: ['管理コンソール', 'Admin console', 'Admin-Konsole', 'وحدة الإدارة'],
	permConsole: [
		'管理コンソールへのアクセス',
		'Admin console access',
		'Zugriff auf die Admin-Konsole',
		'الوصول إلى وحدة الإدارة'
	],
	permConsoleDesc: [
		'管理コンソールにログインできます',
		'Can sign in to the admin console',
		'Kann sich an der Admin-Konsole anmelden',
		'يمكنه تسجيل الدخول إلى وحدة الإدارة'
	],
	grpClients: ['OAuth クライアント', 'OAuth clients', 'OAuth-Clients', 'عملاء OAuth'],
	permView: ['閲覧', 'View', 'Anzeigen', 'عرض'],
	permViewDesc: [
		'一覧と詳細を見る',
		'See the list and details',
		'Liste und Details sehen',
		'عرض القائمة والتفاصيل'
	],
	permWrite: ['作成・更新', 'Create and update', 'Erstellen und ändern', 'إنشاء وتحديث'],
	permWriteDesc: [
		'新しく作る・内容を変える',
		'Add new ones and change them',
		'Neue anlegen und ändern',
		'إضافة عناصر جديدة وتعديلها'
	],
	permDeleteDesc: ['取り消せません', 'Cannot be undone', 'Nicht umkehrbar', 'لا يمكن التراجع'],
	permRevoke: ['失効させる', 'Revoke', 'Widerrufen', 'إبطال'],
	permRevokeDesc: [
		'利用者をログアウトさせる',
		'Sign the user out',
		'Die Person abmelden',
		'تسجيل خروج المستخدم'
	],
	builtInMethods: [
		'組み込みの認証手段',
		'Built-in authentication methods',
		'Integrierte Anmeldeverfahren',
		'طرق المصادقة المدمجة'
	],
	builtInDesc: [
		'このテナントで、Authrim の認証手段をどの場面で使えるかを選びます。',
		'Choose where Authrim’s own methods can be used in this tenant.',
		'Legen Sie fest, wo die Authrim-eigenen Verfahren in diesem Mandanten genutzt werden.',
		'اختر أين يمكن استخدام طرق Authrim في هذا المستأجر.'
	],
	colMethod: ['認証手段', 'Method', 'Verfahren', 'الطريقة'],
	useSignup: ['登録', 'Sign-up', 'Registrierung', 'التسجيل'],
	useLogin: ['ログイン', 'Sign-in', 'Anmeldung', 'تسجيل الدخول'],
	useReauth: ['再認証', 'Re-authentication', 'Erneute Authentifizierung', 'إعادة المصادقة'],
	useLinking: ['アカウント連携', 'Account linking', 'Kontoverknüpfung', 'ربط الحسابات'],
	emailCodeDesc: [
		'メールで届くコードを入力して本人確認します。',
		'Confirms the user with a code sent by email.',
		'Bestätigt die Person mit einem per E-Mail gesendeten Code.',
		'يتحقق من المستخدم برمز يُرسل عبر البريد.'
	],
	methodTotp: ['認証アプリ', 'Authenticator app', 'Authenticator-App', 'تطبيق المصادقة'],
	methodTotpDesc: [
		'認証アプリの 6 桁のコード（TOTP）で本人確認します。',
		'Confirms the user with a six-digit code from an authenticator app (TOTP).',
		'Bestätigt die Person mit einem sechsstelligen Code aus einer Authenticator-App (TOTP).',
		'يتحقق من المستخدم برمز من ستة أرقام من تطبيق المصادقة (TOTP).'
	],
	methodDirectory: [
		'ディレクトリのパスワード',
		'Directory password',
		'Verzeichnispasswort',
		'كلمة مرور الدليل'
	],
	methodDirectoryDesc: [
		'組織のディレクトリに対してパスワードを確認します。ログインでのみ使えます。',
		'Checks the password against your organisation’s directory. Sign-in only.',
		'Prüft das Passwort gegen das Verzeichnis Ihrer Organisation. Nur zur Anmeldung.',
		'يتحقق من كلمة المرور مقابل دليل مؤسستك. لتسجيل الدخول فقط.'
	],
	methodDirectoryLink: [
		'ディレクトリ認証の設定を開く',
		'Open directory authentication settings',
		'Verzeichnisauthentifizierung öffnen',
		'فتح إعدادات مصادقة الدليل'
	],
	langShown: ['表示する言語', 'Languages shown', 'Angezeigte Sprachen', 'اللغات المعروضة'],
	langShownDesc: [
		'ログイン画面などの言語切り替えに出す言語です。',
		'The languages offered in the language switch on the sign-in pages.',
		'Die Sprachen, die auf den Anmeldeseiten zur Auswahl stehen.',
		'اللغات المتاحة في مبدّل اللغة في صفحات تسجيل الدخول.'
	],
	langDefault: ['既定の言語', 'Default language', 'Standardsprache', 'اللغة الافتراضية'],
	langDefaultDesc: [
		'利用者の言語に対応していないときに使います。表示する言語から選びます。',
		'Used when the user’s language is not offered. Chosen from the languages shown.',
		'Wird genutzt, wenn die Sprache der Person nicht angeboten wird. Aus den angezeigten Sprachen.',
		'تُستخدم عندما لا تكون لغة المستخدم متاحة. تُختار من اللغات المعروضة.'
	],
	langFirst: [
		'先頭に表示する言語',
		'Languages listed first',
		'Zuerst aufgeführte Sprachen',
		'اللغات المدرجة أولاً'
	],
	langFirstDesc: [
		'言語が多いとき、よく使う言語を一覧の先頭に出します。',
		'With many languages, the ones used most are listed first.',
		'Bei vielen Sprachen werden die meistgenutzten zuerst aufgeführt.',
		'عند كثرة اللغات، تُدرج الأكثر استخدامًا أولاً.'
	],
	langFirstNeedsMore: [
		'表示する言語が 11 件以上のときに選べます。',
		'Available when 11 or more languages are shown.',
		'Verfügbar, wenn 11 oder mehr Sprachen angezeigt werden.',
		'متاح عند عرض 11 لغة أو أكثر.'
	],
	langEnglishNames: [
		'英語名を併記する',
		'Also show English names',
		'Englische Namen zusätzlich anzeigen',
		'إظهار الأسماء الإنجليزية أيضًا'
	],
	langEnglishNamesDesc: [
		'言語切り替えで「Japanese（日本語）」のように英語名も出します。同じ名前は 1 回だけ表示します。',
		'The language switch shows e.g. “Japanese (日本語)”. Names that match are shown once.',
		'Die Sprachauswahl zeigt z. B. „Japanese (日本語)“. Gleiche Namen erscheinen nur einmal.',
		'يعرض مبدّل اللغة مثلًا “Japanese (日本語)”. تُعرض الأسماء المتطابقة مرة واحدة.'
	],
	langDefaultNote: ['既定', 'default', 'Standard', 'افتراضي'],
	plugins: ['プラグイン', 'Plugins', 'Plugins', 'الإضافات'],
	pluginOfficial: ['公式', 'Official', 'Offiziell', 'رسمي'],
	pluginBeta: ['ベータ', 'Beta', 'Beta', 'تجريبي'],
	pluginStable: ['安定版', 'Stable', 'Stabil', 'مستقر'],
	pluginNoHealth: [
		'ヘルスデータなし',
		'No health data',
		'Keine Zustandsdaten',
		'لا توجد بيانات حالة'
	],
	pluginNeedsConfig: ['要設定', 'Needs configuration', 'Konfiguration nötig', 'يحتاج إلى إعداد'],
	pluginHealthy: ['正常', 'Healthy', 'In Ordnung', 'سليم'],
	pluginCheckHealth: ['ヘルスチェック', 'Check health', 'Zustand prüfen', 'فحص الحالة'],
	pluginEmailDesc: [
		'Cloudflare Workers のメール送信機能で、トランザクションメールを送ります。',
		'Sends transactional email through the Cloudflare Workers email binding.',
		'Versendet Transaktions-E-Mails über die E-Mail-Bindung von Cloudflare Workers.',
		'يرسل رسائل المعاملات عبر ربط البريد في Cloudflare Workers.'
	],
	pluginHumanDesc: [
		'ログイン画面で、操作しているのが人かどうかを確かめます。',
		'Checks that a person, not a bot, is signing in.',
		'Prüft, dass ein Mensch und kein Bot sich anmeldet.',
		'يتحقق من أن من يسجّل الدخول شخص وليس برنامجًا آليًا.'
	],
	pluginConsoleDesc: [
		'通知をコンソールに出力します。開発・テスト専用です。',
		'Writes notifications to the console. For development and testing only.',
		'Schreibt Benachrichtigungen in die Konsole. Nur für Entwicklung und Tests.',
		'يكتب الإشعارات في وحدة التحكم. للتطوير والاختبار فقط.'
	],
	pluginResendDesc: [
		'Resend API でメールを送ります。ワンタイムコードやパスワード再設定に使えます。',
		'Sends email via the Resend API, e.g. one-time codes and password resets.',
		'Versendet E-Mails über die Resend-API, z. B. Einmalcodes und Passwort-Zurücksetzungen.',
		'يرسل البريد عبر واجهة Resend، مثل الرموز لمرة واحدة وإعادة تعيين كلمة المرور.'
	],
	socialTitle: [
		'ソーシャルログイン',
		'Social sign-in',
		'Soziale Anmeldung',
		'تسجيل الدخول الاجتماعي'
	],
	socialDesc: [
		'この会社のアカウントでログインできるようにします。',
		'Lets people sign in with their account at this provider.',
		'Ermöglicht die Anmeldung mit dem Konto bei diesem Anbieter.',
		'يتيح تسجيل الدخول بحساب لدى هذا المزوّد.'
	],
	configure: ['設定する', 'Configure', 'Konfigurieren', 'إعداد'],
	screenName: ['新規登録画面', 'Sign-up screen', 'Registrierungsseite', 'شاشة التسجيل'],
	builderHint: [
		'左から部品を追加し、中央で並べ、右で設定します。',
		'Add parts from the left, arrange them in the middle, set them up on the right.',
		'Fügen Sie links Bausteine hinzu, ordnen Sie sie in der Mitte an und stellen Sie sie rechts ein.',
		'أضف الأجزاء من اليسار، ورتّبها في الوسط، واضبطها على اليمين.'
	],
	tabItems: ['項目', 'Items', 'Elemente', 'العناصر'],
	tabPreview: ['プレビュー', 'Preview', 'Vorschau', 'معاينة'],
	tabLocalize: ['ローカライズ', 'Localization', 'Lokalisierung', 'الترجمة'],
	partHeading: ['見出し', 'Heading', 'Überschrift', 'عنوان'],
	partHeadingDesc: [
		'画面の見出しを表示します',
		'Shows the page heading',
		'Zeigt die Seitenüberschrift',
		'يعرض عنوان الصفحة'
	],
	partAuth: ['認証ボタン', 'Sign-in button', 'Anmelde-Schaltfläche', 'زر المصادقة'],
	partAuthDesc: [
		'認証手段を 1 つ、その操作と一緒に置きます',
		'One authentication method with its action',
		'Ein Anmeldeverfahren mit seiner Aktion',
		'طريقة مصادقة واحدة مع إجرائها'
	],
	partField: ['入力欄', 'Input field', 'Eingabefeld', 'حقل إدخال'],
	partFieldDesc: [
		'名前やメールアドレスなどを入力してもらいます',
		'Asks for a name, an email address and so on',
		'Fragt Name, E-Mail-Adresse usw. ab',
		'يطلب الاسم أو البريد الإلكتروني وغيرها'
	],
	partText: ['文章', 'Text', 'Text', 'نص'],
	partTextDesc: [
		'短い説明を表示します',
		'Shows a short explanation',
		'Zeigt eine kurze Erklärung',
		'يعرض شرحًا قصيرًا'
	],
	partDivider: ['区切り', 'Divider', 'Trennlinie', 'فاصل'],
	partDividerDesc: [
		'選択肢の間に「または」の線を引きます',
		'An “or” line between choices',
		'Eine „oder“-Linie zwischen Optionen',
		'خط «أو» بين الخيارات'
	],
	partLink: ['リンク', 'Link', 'Link', 'رابط'],
	partLinkDesc: [
		'別の画面へのリンク',
		'A link to another screen',
		'Ein Link zu einer anderen Seite',
		'رابط إلى شاشة أخرى'
	],
	tCreateAccount: ['アカウントを作成', 'Create your account', 'Konto erstellen', 'أنشئ حسابك'],
	tWithPasskey: [
		'パスキーで作成',
		'Create with a passkey',
		'Mit Passkey erstellen',
		'إنشاء باستخدام مفتاح مرور'
	],
	tOr: ['または', 'or', 'oder', 'أو'],
	tEmailCode: [
		'メールでコードを受け取る',
		'Send a code by email',
		'Code per E-Mail senden',
		'إرسال رمز عبر البريد'
	],
	tWithApp: [
		'認証アプリで作成',
		'Create with an authenticator app',
		'Mit Authenticator-App erstellen',
		'إنشاء باستخدام تطبيق المصادقة'
	],
	tOtherAccount: [
		'別のアカウントで続ける',
		'Continue with another account',
		'Mit einem anderen Konto fortfahren',
		'المتابعة بحساب آخر'
	],
	partSettings: ['部品の設定', 'Part settings', 'Baustein-Einstellungen', 'إعدادات الجزء'],
	partLabel: ['表示する文言', 'Label', 'Beschriftung', 'التسمية'],
	partCondition: ['表示する条件', 'Display condition', 'Anzeigebedingung', 'شرط العرض'],
	condAlways: ['常に表示', 'Always', 'Immer', 'دائمًا'],
	condFeature: [
		'手段が有効なときだけ',
		'Only when the method is on',
		'Nur wenn das Verfahren aktiv ist',
		'فقط عند تفعيل الطريقة'
	],
	noSelection: [
		'部品を選ぶと、ここで設定できます',
		'Select a part to set it up here',
		'Wählen Sie einen Baustein, um ihn hier einzustellen',
		'حدد جزءًا لإعداده هنا'
	],
	tChoose: ['選んでください', 'Choose…', 'Bitte wählen…', 'اختر…'],
	loginFlow: ['ログイン', 'Sign-in', 'Anmeldung', 'تسجيل الدخول'],
	loginContract: [
		'認証の処理契約',
		'Authentication contract',
		'Authentifizierungsvertrag',
		'عقد المصادقة'
	],
	loginStart: ['ログイン開始', 'Sign-in starts', 'Anmeldung beginnt', 'بدء تسجيل الدخول'],
	loginStartDetail: [
		'LoginUI／独自UI',
		'Login UI / your own UI',
		'Anmeldeoberfläche / eigene Oberfläche',
		'واجهة الدخول / واجهتك الخاصة'
	],
	loginDone: [
		'認証完了',
		'Authentication complete',
		'Authentifizierung abgeschlossen',
		'اكتمال المصادقة'
	],
	loginDoneDetail: [
		'呼び出し元の処理を再開',
		'The caller resumes',
		'Der Aufrufer setzt fort',
		'تستأنف الجهة الطالبة عملها'
	],
	stepAuthn: [
		'利用者の認証',
		'Authenticating the user',
		'Authentifizierung der Person',
		'مصادقة المستخدم'
	],
	stepMfa: [
		'追加認証',
		'Step-up authentication',
		'Zusätzliche Authentifizierung',
		'المصادقة الإضافية'
	],
	stepSession: [
		'ログインの完了',
		'Finishing the sign-in',
		'Abschluss der Anmeldung',
		'إنهاء تسجيل الدخول'
	],
	partMethods: ['認証手段・認証元', 'Methods & sources', 'Verfahren & Quellen', 'الطرق والمصادر'],
	partValidation: ['認証の検証条件', 'Validation rules', 'Prüfbedingungen', 'شروط التحقق'],
	partConditions: ['追加認証の条件', 'When step-up applies', 'Wann sie greift', 'متى تنطبق'],
	partSession: ['セッション確立', 'Establishing the session', 'Sitzung herstellen', 'إنشاء الجلسة'],
	partReturn: ['認証結果の返却', 'Returning the result', 'Ergebnis zurückgeben', 'إعادة النتيجة'],
	authrimScope: [
		'Authrimが実行する処理',
		'Handled by Authrim',
		'Von Authrim ausgeführte Verarbeitung',
		'المعالجة التي ينفّذها Authrim'
	],
	stepMapping: ['属性マッピング', 'Attribute mapping', 'Attributzuordnung', 'ربط السمات'],
	stepConsent: ['同意', 'Consent', 'Einwilligung', 'الموافقة'],
	stepRole: ['ロール割り当て', 'Role assignment', 'Rollenzuweisung', 'تعيين الأدوار'],
	stepToken: ['SCIM トークン', 'SCIM token', 'SCIM-Token', 'رمز SCIM'],
	stepIat: [
		'初期アクセストークン',
		'Initial access token',
		'Initiales Zugriffstoken',
		'رمز الوصول الأولي'
	],
	stDone: ['設定済み', 'Configured', 'Konfiguriert', 'مهيأ'],
	stPartial: ['一部設定済み', 'Partly configured', 'Teilweise konfiguriert', 'مهيأ جزئيًا'],
	stTodo: ['未設定', 'Not set', 'Nicht festgelegt', 'غير مهيأ'],
	stRequired: [
		'必須・未設定',
		'Required — not set',
		'Erforderlich – nicht festgelegt',
		'مطلوب — غير مهيأ'
	],
	optMappingDesc: [
		'受け取る属性を Authrim の項目に対応づけます',
		'Map incoming attributes to Authrim fields',
		'Eingehende Attribute Authrim-Feldern zuordnen',
		'ربط السمات الواردة بحقول Authrim'
	],
	optConsentDesc: [
		'同意文を表示して記録します',
		'Show and record a consent statement',
		'Einwilligungstext anzeigen und protokollieren',
		'عرض بيان الموافقة وتسجيله'
	],
	optIatDesc: [
		'動的登録用のトークンを発行します',
		'Issue a token for dynamic registration',
		'Token für dynamische Registrierung ausstellen',
		'إصدار رمز للتسجيل الديناميكي'
	],
	codeJs: [
		'クレーム変換スクリプト',
		'Claim transform script',
		'Skript zur Claim-Umwandlung',
		'برنامج تحويل المطالبات'
	],
	codeCss: [
		'ログイン画面のカスタム CSS',
		'Sign-in page custom CSS',
		'Eigenes CSS der Anmeldeseite',
		'CSS مخصص لصفحة تسجيل الدخول'
	],
	codeXml: [
		'SP メタデータ（XML）',
		'SP metadata (XML)',
		'SP-Metadaten (XML)',
		'بيانات SP الوصفية (XML)'
	],
	codeShell: ['セットアップコマンド', 'Setup command', 'Einrichtungsbefehl', 'أمر الإعداد'],
	codeJson: [
		'クライアント設定（JSON）',
		'Client settings (JSON)',
		'Client-Einstellungen (JSON)',
		'إعدادات العميل (JSON)'
	],
	readOnlyHint: [
		'読み取り専用。コピーして使ってください。',
		'Read-only. Copy it to use it.',
		'Schreibgeschützt. Zum Verwenden kopieren.',
		'للقراءة فقط. انسخه لاستخدامه.'
	],
	sessionTtl: ['セッションの有効時間', 'Session lifetime', 'Sitzungsdauer', 'مدة الجلسة'],
	minutes: ['分', 'min', 'Min.', 'دقيقة'],
	rolloutShare: [
		'新しいログイン画面を出す割合',
		'Share of users on the new sign-in page',
		'Anteil der Nutzer mit neuer Anmeldeseite',
		'نسبة المستخدمين في صفحة الدخول الجديدة'
	],
	rolloutHint: [
		'段階的に公開する割合です。',
		'Gradual rollout percentage.',
		'Prozentsatz für die schrittweise Einführung.',
		'نسبة الإطلاق التدريجي.'
	],
	riskThreshold: ['リスク判定のしきい値', 'Risk threshold', 'Risikoschwelle', 'حد المخاطر'],
	volume: ['通知音量', 'Notification volume', 'Benachrichtigungslautstärke', 'مستوى صوت الإشعارات'],
	mfaMode: [
		'多要素認証',
		'Multi-factor authentication',
		'Mehr-Faktor-Authentifizierung',
		'المصادقة متعددة العوامل'
	],
	mfaOff: ['使わない', 'Off', 'Aus', 'إيقاف'],
	mfaOffDesc: [
		'パスワードまたはパスキーだけでログインします。',
		'Sign in with a password or passkey only.',
		'Anmeldung nur mit Passwort oder Passkey.',
		'تسجيل الدخول بكلمة مرور أو مفتاح مرور فقط.'
	],
	mfaRisk: [
		'リスクが高いときだけ',
		'Only when risk is high',
		'Nur bei hohem Risiko',
		'فقط عند ارتفاع المخاطر'
	],
	mfaRiskDesc: [
		'新しい端末や場所からのログインで求めます。',
		'Asked for sign-ins from a new device or place.',
		'Bei Anmeldungen von neuen Geräten oder Orten.',
		'يُطلب عند تسجيل الدخول من جهاز أو مكان جديد.'
	],
	mfaAlways: ['常に求める', 'Always', 'Immer', 'دائمًا'],
	mfaAlwaysDesc: [
		'毎回のログインで求めます。',
		'Asked at every sign-in.',
		'Bei jeder Anmeldung.',
		'يُطلب في كل تسجيل دخول.'
	],
	region: ['データの保存場所', 'Data location', 'Datenstandort', 'موقع البيانات'],
	regionHint: [
		'あとから変更できません。',
		'Cannot be changed later.',
		'Kann später nicht geändert werden.',
		'لا يمكن تغييره لاحقًا.'
	],
	regionJp: ['日本', 'Japan', 'Japan', 'اليابان'],
	regionEu: [
		'EU（フランクフルト）',
		'EU (Frankfurt)',
		'EU (Frankfurt)',
		'الاتحاد الأوروبي (فرانكفورت)'
	],
	regionUs: [
		'米国（バージニア）',
		'United States (Virginia)',
		'USA (Virginia)',
		'الولايات المتحدة (فيرجينيا)'
	],
	regionApac: [
		'アジア太平洋（シンガポール）',
		'Asia Pacific (Singapore)',
		'Asien-Pazifik (Singapur)',
		'آسيا والمحيط الهادئ (سنغافورة)'
	],
	period: ['期間', 'Period', 'Zeitraum', 'الفترة'],
	day: ['24時間', '24 hours', '24 Stunden', '24 ساعة'],
	week: ['7日', '7 days', '7 Tage', '7 أيام'],
	month: ['30日', '30 days', '30 Tage', '30 يومًا'],
	viewMode: ['表示方法', 'View', 'Ansicht', 'طريقة العرض'],
	viewList: ['一覧', 'List', 'Liste', 'قائمة'],
	viewFlow: ['フロー', 'Flow', 'Ablauf', 'تدفق'],
	templates: ['属性テンプレート', 'Attribute templates', 'Attributvorlagen', 'قوالب السمات'],
	catGeneral: ['一般', 'General settings', 'Allgemeine Einstellungen', 'إعدادات عامة'],
	catAcademic: [
		'学術フェデレーション',
		'Academic federation',
		'Akademische Föderation',
		'الاتحاد الأكاديمي'
	],
	catVendor: ['ベンダー固有', 'Vendor specific', 'Herstellerspezifisch', 'خاص بالمورّد'],
	kind: ['SAML テンプレート', 'SAML template', 'SAML-Vorlage', 'قالب SAML'],
	version: ['バージョン', 'Version', 'Version', 'الإصدار'],
	updated: ['更新日', 'Updated', 'Aktualisiert', 'آخر تحديث'],
	previewTpl: ['プレビュー', 'Preview', 'Vorschau', 'معاينة'],
	useTpl: [
		'このテンプレートを使う',
		'Use this template',
		'Diese Vorlage verwenden',
		'استخدام هذا القالب'
	],
	toLight: ['ライトにする', 'Switch to light', 'Zu Hell wechseln', 'التبديل إلى الفاتح'],
	toDark: ['ダークにする', 'Switch to dark', 'Zu Dunkel wechseln', 'التبديل إلى الداكن'],
	transitionNote: [
		'色は 1.8 秒かけて移り、同時に全体へ薄い膜を一度かぶせます。',
		'Colours move over 1.8 s while a light wash covers the screen once.',
		'Farben wechseln über 1,8 s, dabei legt sich einmal ein leichter Schleier über alles.',
		'تنتقل الألوان خلال 1.8 ثانية بينما يغطي الشاشة غشاء خفيف مرة واحدة.'
	],
	createdAt: ['作成日時', 'Created', 'Erstellt', 'تاريخ الإنشاء'],
	lastSignInAt: ['最終ログイン', 'Last sign-in', 'Letzte Anmeldung', 'آخر تسجيل دخول'],
	certExpiry: ['証明書の有効期限', 'Certificate expiry', 'Zertifikatsablauf', 'انتهاء الشهادة'],
	releaseDate: ['リリース日', 'Release date', 'Veröffentlichungsdatum', 'تاريخ الإصدار'],
	auditAt: [
		'記録時刻（常に UTC）',
		'Recorded (always UTC)',
		'Erfasst (immer UTC)',
		'وقت التسجيل (دائمًا UTC)'
	],
	zoneUtc: ['UTC で表示', 'Shown in UTC', 'In UTC', 'بتوقيت UTC'],
	zoneLocal: ['ローカルで表示', 'Shown in local time', 'In Ortszeit', 'بالتوقيت المحلي'],
	withOther: ['もう一方を併記', 'With the other zone', 'Mit der anderen Zone', 'مع المنطقة الأخرى'],
	clientId: ['クライアント ID', 'Client ID', 'Client-ID', 'معرّف العميل'],
	docsLink: [
		'SAML の設定ガイド',
		'SAML setup guide',
		'SAML-Einrichtungsanleitung',
		'دليل إعداد SAML'
	],
	auditLink: ['監査ログを見る', 'View audit log', 'Prüfprotokoll anzeigen', 'عرض سجل التدقيق'],
	linkSentence1: ['設定の詳細は', 'See the', 'Details finden Sie im', 'راجع'],
	linkSentence2: ['を参照してください。', 'for details.', '.', 'للتفاصيل.'],
	sameTab: [
		'同じタブで開く',
		'Opens in this tab',
		'Öffnet in diesem Tab',
		'يُفتح في علامة التبويب نفسها'
	],
	newTabLabel: [
		'別タブで開く',
		'Opens in a new tab',
		'Öffnet in neuem Tab',
		'يُفتح في علامة تبويب جديدة'
	]
} satisfies Record<string, [string, string, string, string]>;

export type SampleKey = keyof typeof SAMPLES;

const INDEX: Record<Locale, number> = { ja: 0, en: 1, de: 2, ar: 3 };

/** Copy given as [ja, en, de, ar], in the toolbar locale (pseudo-localised in Pseudo). */
export function localized(copy: readonly [string, string, string, string]): string {
	if (i18n.pseudo) return pseudoLocalize(copy[INDEX.en]);
	return copy[INDEX[i18n.locale]];
}

/** Sample copy in the locale chosen in the Storybook toolbar (reactive). */
export function sample(key: SampleKey): string {
	if (i18n.pseudo) return pseudoLocalize(SAMPLES[key][INDEX.en]);
	return SAMPLES[key][INDEX[i18n.locale]];
}
