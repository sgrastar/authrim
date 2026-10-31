/**
 * Storybook demo data: the parts of the legacy screen editor (/admin/screens) and the copy of
 * their settings, in every console locale. Not used by the app.
 *
 * The legacy "layout row" part is not here: rows are structural in the new editor, and a row's
 * own settings (columns, display condition) are edited by selecting the row.
 *
 * Backend and API work this demo assumes (grep "TODO(api)" / "TODO(runtime)" for the details
 * next to each setting). Today's storage: screens.fields_json as ScreenField[] and
 * localizations_json as ScreenLocalization (ar-lib-core/src/types/screens.ts, Admin API in
 * ar-management/src/admin-screens.ts); the Identity Schema is custom_claim_schemas (Admin API
 * in ar-management/src/admin-custom-claims.ts, write checks in
 * ar-lib-core/src/services/custom-claims/write-validator.ts).
 *
 * 1. ScreenField / ScreenBlockType
 *    - New block types 'select' | 'radio' | 'checkbox'. Migrate identity_field with
 *      value_type 'boolean' to 'checkbox' and retire value_type (the Login UI's
 *      RuntimeScreen.svelte branches on it today).
 *    - `show_label` (default true), `store_to_profile` (default true; see PartSettings.linked)
 *      and `options` (select/radio when not stored to the profile).
 *    - Layout: rows of 1-3 columns replace the 'layout_row' marker blocks. Either persist
 *      rows explicitly ({ id, columns, display_condition }) or keep writing layout_row +
 *      layout_columns / layout_column + order and rebuild rows on load; a row's display
 *      condition must survive either way.
 * 2. ScreenLocalization.fields[block_id] gains `options: Record<value, label>` for screen-local
 *    options. Options of a profile attribute are translated on the schema, not per screen.
 * 3. Identity Schema
 *    - field_type 'enum' with validation_rules.enum_values (string[]) exists, but values have
 *      no labels. Add labels and their translations per value, e.g.
 *      enum_options: [{ value, labels: { [locale]: text } }], validated by the Admin API.
 *    - The runtime screen payload must carry the localized options of every enum attribute a
 *      screen uses, read at request time (never copied into the screen), so a schema change
 *      shows up on every screen at once.
 *    - Removing or renaming an enum value that users already hold needs a guard (block, or
 *      warn and migrate); screens that reference the attribute should be listed.
 *    - The attribute picker needs every active attribute - the fixed profile keys (email,
 *      given_name, ...) as well as custom ones - with field_key, field_type, cardinality and
 *      the number of enum values. Multi-value attributes (cardinality 'multi') are not
 *      bindable to these parts yet.
 * 4. The Admin API must enforce the same binding rules as the UI (SCHEMA_TYPES_FOR below) on
 *    save, so a screen written through the API cannot bind a checkbox to a string attribute.
 */
import type { IconName } from '../icons/icons';
import { localized } from './sample';

type Copy = readonly [string, string, string, string];

export type PartGroup = 'content' | 'input' | 'signin' | 'account' | 'security';

/**
 * Grouped by what the part does, and where it is used: sign-in and sign-up screens use the
 * first three groups, the account page the last two.
 */
export const PART_GROUPS: Record<PartGroup, Copy> = {
	content: ['表示', 'Content', 'Inhalt', 'المحتوى'],
	input: ['入力', 'Inputs', 'Eingaben', 'المدخلات'],
	signin: ['認証', 'Sign-in', 'Anmeldung', 'تسجيل الدخول'],
	account: ['アカウント情報', 'Account', 'Konto', 'الحساب'],
	security: ['セキュリティ', 'Security', 'Sicherheit', 'الأمان']
};

export interface PartDef {
	kind: string;
	group: PartGroup;
	icon: IconName;
	name: Copy;
	description: Copy;
}

export const PART_DEFS: readonly PartDef[] = [
	{
		kind: 'heading',
		group: 'content',
		icon: 'textH',
		name: ['見出し', 'Heading', 'Überschrift', 'عنوان'],
		description: [
			'画面のタイトルや小見出しを置きます。',
			'A title or a section heading.',
			'Ein Titel oder eine Zwischenüberschrift.',
			'عنوان أو عنوان فرعي.'
		]
	},
	{
		kind: 'text',
		group: 'content',
		icon: 'textAlignLeft',
		name: ['テキスト', 'Text', 'Text', 'نص'],
		description: [
			'説明文や補足を置きます。',
			'Helper copy or static text.',
			'Hilfetext oder statischer Text.',
			'نص توضيحي أو ثابت.'
		]
	},
	{
		kind: 'identity_field',
		group: 'input',
		icon: 'textbox',
		name: ['入力フォーム', 'Input field', 'Eingabefeld', 'حقل إدخال'],
		description: [
			'文字を入力してもらいます。メールアドレスや名前などのユーザー情報に紐づけることも、画面だけで使うこともできます。',
			'Asks for text. It can fill in a user attribute such as an email address or a name, or be used on this screen only.',
			'Fragt Text ab. Er kann ein Benutzerattribut wie E-Mail-Adresse oder Name füllen oder nur auf dieser Seite dienen.',
			'يطلب نصًا. يمكن ربطه بسمة مستخدم مثل البريد الإلكتروني أو الاسم، أو استخدامه في هذه الشاشة فقط.'
		]
	},
	{
		kind: 'select',
		group: 'input',
		icon: 'caretUpDown',
		name: ['プルダウン', 'Dropdown', 'Auswahlliste', 'قائمة منسدلة'],
		description: [
			'選択肢の中から 1 つを選んでもらいます。選択肢が多いときに向いています。',
			'Asks to pick one option from a list; suits longer lists.',
			'Lässt eine Option aus einer Liste wählen; passt zu längeren Listen.',
			'يطلب اختيار خيار واحد من قائمة؛ يناسب القوائم الطويلة.'
		]
	},
	{
		kind: 'radio',
		group: 'input',
		icon: 'radio',
		name: ['ラジオボタン', 'Radio buttons', 'Optionsfelder', 'أزرار اختيار'],
		description: [
			'選択肢をすべて並べて、1 つを選んでもらいます。選択肢が少ないときに向いています。',
			'Shows every option and asks to pick one; suits a few options.',
			'Zeigt alle Optionen und lässt eine wählen; passt zu wenigen Optionen.',
			'يعرض كل الخيارات ويطلب اختيار واحد؛ يناسب الخيارات القليلة.'
		]
	},
	{
		kind: 'checkbox',
		group: 'input',
		icon: 'checkSquare',
		name: ['チェックボックス', 'Checkbox', 'Kontrollkästchen', 'مربع اختيار'],
		description: [
			'はい／いいえで答えられることを確かめます（お知らせを受け取る、など）。',
			'Asks a yes-or-no question, such as whether to receive news.',
			'Stellt eine Ja/Nein-Frage, etwa ob Neuigkeiten gewünscht sind.',
			'يطرح سؤالًا بنعم أو لا، مثل تلقي الأخبار.'
		]
	},
	{
		kind: 'link',
		group: 'content',
		icon: 'link',
		name: ['リンク', 'Link', 'Link', 'رابط'],
		description: [
			'ページ内（#）、相対パス、HTTPS のリンクを置きます。',
			'A link to an #anchor, a relative path or an HTTPS address.',
			'Ein Link zu einem #Anker, einem relativen Pfad oder einer HTTPS-Adresse.',
			'رابط إلى #مرساة أو مسار نسبي أو عنوان HTTPS.'
		]
	},
	{
		kind: 'divider',
		group: 'content',
		icon: 'lineSegment',
		name: ['区切り線', 'Divider', 'Trennlinie', 'فاصل'],
		description: [
			'画面の中を区切ります。「または」などのラベルも付けられます。',
			'Separates parts of the page, optionally with a label such as “or”.',
			'Trennt Bereiche der Seite, optional mit einer Beschriftung wie „oder“.',
			'يفصل أجزاء الصفحة، مع تسمية اختيارية مثل «أو».'
		]
	},
	{
		kind: 'auth_widget',
		group: 'signin',
		icon: 'squaresFour',
		name: ['認証ウィジェット', 'Auth widget', 'Anmelde-Widget', 'مكوّن المصادقة'],
		description: [
			'認証方式を 1 つ、必要な入力欄と送信ボタンごと置きます。',
			'One authentication method with the inputs and action it needs.',
			'Ein Anmeldeverfahren mit den nötigen Eingaben und der Aktion.',
			'طريقة مصادقة واحدة مع مدخلاتها وإجرائها.'
		]
	},
	{
		kind: 'code_input_widget',
		group: 'signin',
		icon: 'password',
		name: ['コード入力', 'Code input', 'Code-Eingabe', 'إدخال الرمز'],
		description: [
			'メールのワンタイムコードや認証アプリのコードを入力する画面を置きます。',
			'Where a one-time code from email or an authenticator app is entered.',
			'Eingabe eines Einmalcodes aus E-Mail oder Authenticator-App.',
			'مكان إدخال رمز لمرة واحدة من البريد أو تطبيق المصادقة.'
		]
	},
	{
		kind: 'consent_widget',
		group: 'input',
		icon: 'handshake',
		name: ['同意ウィジェット', 'Consent widget', 'Einwilligungs-Widget', 'مكوّن الموافقة'],
		description: [
			'フローで選んだ同意ポリシーと、提供先プロフィールの必須・任意項目を表示します。',
			'Shows the flow’s consent policy and the required or optional destination profile fields.',
			'Zeigt die Einwilligungsrichtlinie des Ablaufs und die Pflicht- oder optionalen Profilfelder.',
			'يعرض سياسة الموافقة للمسار وحقول ملف الوجهة الإلزامية أو الاختيارية.'
		]
	},
	{
		kind: 'security_verification',
		group: 'signin',
		icon: 'shieldCheck',
		name: ['セキュリティ確認', 'Security check', 'Sicherheitsprüfung', 'التحقق الأمني'],
		description: [
			'CAPTCHA などのセキュリティ確認を置きます。',
			'A security check such as a CAPTCHA.',
			'Eine Sicherheitsprüfung wie ein CAPTCHA.',
			'تحقق أمني مثل CAPTCHA.'
		]
	},
	{
		kind: 'guest_login_widget',
		group: 'signin',
		icon: 'userCircleDashed',
		name: ['ゲストログイン', 'Guest login', 'Gast-Anmeldung', 'دخول الضيف'],
		description: [
			'ゲストとして入るボタンと、データの保持期間の説明を表示します。',
			'A guest sign-in button and how long guest data is kept.',
			'Eine Schaltfläche für die Gast-Anmeldung und wie lange Gastdaten bleiben.',
			'زر الدخول كضيف ومدة الاحتفاظ ببيانات الضيف.'
		]
	},
	{
		kind: 'account_upgrade_widget',
		group: 'account',
		icon: 'userPlus',
		name: ['ゲストの本登録', 'Guest registration', 'Gast-Registrierung', 'تسجيل الضيف'],
		description: [
			'ゲストの本登録と、削除予定日時を表示します。',
			'Guest registration and the date the guest account will be deleted.',
			'Gast-Registrierung und das Löschdatum des Gastkontos.',
			'تسجيل الضيف وتاريخ حذف حساب الضيف.'
		]
	},
	{
		kind: 'account_profile_widget',
		group: 'account',
		icon: 'userCircle',
		name: ['ユーザー情報', 'User profile', 'Benutzerprofil', 'ملف المستخدم'],
		description: [
			'プロフィールの表示・編集・保存を、確認とエラー表示ごと置きます。',
			'Profile display and editing, with saving, checks and errors.',
			'Profilanzeige und -bearbeitung mit Speichern, Prüfung und Fehlern.',
			'عرض الملف الشخصي وتحريره مع الحفظ والتحقق والأخطاء.'
		]
	},
	{
		kind: 'account_device_list_widget',
		group: 'security',
		icon: 'devices',
		name: ['デバイス一覧', 'Device list', 'Geräteliste', 'قائمة الأجهزة'],
		description: [
			'登録されたデバイスと、いま使っているデバイスを表示します。',
			'Registered devices and the one in use.',
			'Registrierte Geräte und das aktuell genutzte.',
			'الأجهزة المسجلة والجهاز المستخدم حاليًا.'
		]
	},
	{
		kind: 'account_session_widget',
		group: 'security',
		icon: 'monitor',
		name: ['セッション管理', 'Sessions', 'Sitzungen', 'الجلسات'],
		description: [
			'ログイン中のセッション一覧と、個別のログアウトを置きます。',
			'Signed-in sessions, each with its own sign-out.',
			'Angemeldete Sitzungen, jeweils mit Abmeldung.',
			'الجلسات النشطة مع تسجيل خروج لكل منها.'
		]
	},
	{
		kind: 'account_passkey_widget',
		group: 'security',
		icon: 'key',
		name: ['パスキー管理', 'Passkeys', 'Passkeys', 'مفاتيح المرور'],
		description: [
			'パスキーの一覧・登録・削除を、再認証ごと置きます。',
			'Passkey list, registration and removal, with re-authentication.',
			'Passkey-Liste, Registrierung und Entfernung mit erneuter Authentifizierung.',
			'قائمة مفاتيح المرور وتسجيلها وإزالتها مع إعادة المصادقة.'
		]
	},
	{
		kind: 'account_totp_widget',
		group: 'security',
		icon: 'deviceMobile',
		name: ['認証アプリ', 'Authenticator app', 'Authenticator-App', 'تطبيق المصادقة'],
		description: [
			'認証アプリの登録・削除、QR コード、バックアップコードを置きます。',
			'Authenticator app setup and removal, QR code and backup codes.',
			'Einrichtung und Entfernung der Authenticator-App, QR-Code und Backup-Codes.',
			'إعداد تطبيق المصادقة وإزالته ورمز QR ورموز الاحتياط.'
		]
	},
	{
		kind: 'account_consent_widget',
		group: 'account',
		icon: 'clipboardText',
		name: ['同意の管理', 'Consents', 'Einwilligungen', 'الموافقات'],
		description: [
			'同意の一覧・詳細と取り下げを置きます。',
			'Consent list and details, with withdrawal.',
			'Einwilligungsliste und Details mit Widerruf.',
			'قائمة الموافقات وتفاصيلها مع السحب.'
		]
	},
	{
		kind: 'account_activity_widget',
		group: 'account',
		icon: 'history',
		name: ['操作履歴', 'Account activity', 'Kontoaktivität', 'نشاط الحساب'],
		description: [
			'アカウントに対する操作の日時と内容を表示します。',
			'When and what was done to the account.',
			'Wann und was am Konto geändert wurde.',
			'متى وما الذي تم على الحساب.'
		]
	},
	{
		kind: 'account_social_account_widget',
		group: 'account',
		icon: 'link',
		name: ['外部アカウント', 'Connected accounts', 'Verknüpfte Konten', 'الحسابات المرتبطة'],
		description: [
			'連携した外部アカウントの一覧と、連携・解除を置きます。',
			'Connected external accounts, with linking and unlinking.',
			'Verknüpfte externe Konten mit Verknüpfen und Trennen.',
			'الحسابات الخارجية المرتبطة مع الربط وإلغائه.'
		]
	},
	{
		kind: 'account_launcher_widget',
		group: 'account',
		icon: 'rocket',
		name: ['ランチャー', 'Launcher', 'Launcher', 'المشغّل'],
		description: [
			'割り当てられたアプリの検索・カテゴリ・お気に入り・起動を置きます。',
			'Search, categories, favourites and launching of assigned apps.',
			'Suche, Kategorien, Favoriten und Start zugewiesener Apps.',
			'البحث في التطبيقات المعيّنة وتصنيفها وتفضيلها وتشغيلها.'
		]
	}
];

/** Kinds that take a display condition (as in the legacy editor; rows take one too). */
export const CONDITION_KINDS = new Set([
	'divider',
	'heading',
	'text',
	'identity_field',
	'select',
	'radio',
	'checkbox'
]);

/** Parts that ask for input and can fill in a user attribute. */
export const INPUT_KINDS = new Set(['identity_field', 'select', 'radio', 'checkbox']);

export const partDef = (kind: string) => PART_DEFS.find((def) => def.kind === kind);
export const partName = (kind: string) => {
	const def = partDef(kind);
	return def ? localized(def.name) : kind;
};

const SETTINGS = {
	internalId: ['内部 ID', 'Internal ID', 'Interne ID', 'المعرّف الداخلي'],
	internalIdHint: [
		'自動で付けられ、翻訳のキーに使われます。',
		'Given automatically and used as the key for translations.',
		'Wird automatisch vergeben und als Schlüssel für Übersetzungen genutzt.',
		'يُعيَّن تلقائيًا ويُستخدم مفتاحًا للترجمات.'
	],
	label: ['ラベル', 'Label', 'Beschriftung', 'التسمية'],
	showLabel: ['ラベルを表示する', 'Show the label', 'Beschriftung anzeigen', 'عرض التسمية'],
	showLabelInfo: [
		'オフにしても、ラベルは読み上げソフトには読まれます。何を入れる欄か分かるよう、プレースホルダーやヘルプテキストで補ってください。',
		'Screen readers still read the label when it is hidden. Make clear what goes in the field with a placeholder or help text.',
		'Screenreader lesen die Beschriftung auch ausgeblendet vor. Machen Sie mit Platzhalter oder Hilfetext klar, was in das Feld gehört.',
		'تقرأ برامج قراءة الشاشة التسمية حتى عند إخفائها. وضّح المطلوب في الحقل بنص نائب أو نص مساعدة.'
	],
	condition: ['表示条件', 'Display condition', 'Anzeigebedingung', 'شرط العرض'],
	condAlways: ['常に表示', 'Always show', 'Immer anzeigen', 'العرض دائمًا'],
	condFeature: [
		'特定の機能が有効なときに表示',
		'Show when a feature is on',
		'Anzeigen, wenn eine Funktion aktiv ist',
		'العرض عند تفعيل ميزة'
	],
	condHidden: ['表示しない', 'Hidden', 'Ausgeblendet', 'مخفي'],
	feature: ['機能', 'Feature', 'Funktion', 'الميزة'],
	linkDb: [
		'データベースに紐づける',
		'Link to the database',
		'Mit der Datenbank verknüpfen',
		'ربط بقاعدة البيانات'
	],
	linkDbDesc: [
		'入力された値を、ユーザー情報の項目（Identity Schema）として保存します。オフにすると、この画面の中だけで使われます。',
		'Stores the answer in a user attribute (Identity Schema). Off: it is used on this screen only.',
		'Speichert die Antwort in einem Benutzerattribut (Identity Schema). Aus: Sie gilt nur auf dieser Seite.',
		'يحفظ الإجابة في سمة مستخدم (مخطط الهوية). عند الإيقاف: تُستخدم في هذه الشاشة فقط.'
	],
	identity: ['保存先の項目', 'Stored in', 'Gespeichert in', 'يُحفظ في'],
	storeTypes: [
		'{types} 型の項目に保存できます。',
		'Stores in {types} attributes.',
		'Speichert in Attributen vom Typ {types}.',
		'يُحفظ في سمات من النوع {types}.'
	],
	storeChoices: [
		'Enum 型（値が決まっている項目）に保存できます。',
		'Stores in Enum attributes (a fixed set of values).',
		'Speichert in Enum-Attributen (feste Werte).',
		'يُحفظ في سمات Enum (قيم محددة).'
	],
	usable: ['保存できる項目', 'Can store here', 'Hier speicherbar', 'يمكن الحفظ فيها'],
	unusable: [
		'この部品には使えない項目',
		'Not for this part',
		'Nicht für diesen Baustein',
		'غير متاحة لهذا الجزء'
	],
	choicesN: ['選択肢 {n} 件', '{n} options', '{n} Optionen', '{n} خيارات'],
	schemaChoices: [
		'選択肢（Identity Schema で定義）',
		'Options (defined in the Identity Schema)',
		'Optionen (im Identity Schema festgelegt)',
		'الخيارات (معرّفة في مخطط الهوية)'
	],
	schemaChoicesNote: [
		'値と表示名、その翻訳は Identity Schema で管理します。登録画面、プロフィール編集、API のどこからでも同じ値になります。',
		'Values, labels and their translations are managed in the Identity Schema, so sign-up, profile editing and the API all use the same values.',
		'Werte, Bezeichnungen und Übersetzungen werden im Identity Schema verwaltet – Registrierung, Profil und API nutzen dieselben Werte.',
		'تُدار القيم والتسميات وترجماتها في مخطط الهوية، فيستخدم التسجيل وتعديل الملف الشخصي وواجهة API القيم نفسها.'
	],
	editInSchema: [
		'Identity Schema で編集',
		'Edit in the Identity Schema',
		'Im Identity Schema bearbeiten',
		'التعديل في مخطط الهوية'
	],
	fieldEmail: ['メールアドレス', 'Email address', 'E-Mail-Adresse', 'البريد الإلكتروني'],
	placeholder: ['プレースホルダー', 'Placeholder', 'Platzhalter', 'نص العنصر النائب'],
	helpText: ['ヘルプテキスト', 'Help text', 'Hilfetext', 'نص المساعدة'],
	selectPlaceholder: [
		'未選択のときの表示',
		'Shown before a choice',
		'Anzeige vor der Auswahl',
		'ما يظهر قبل الاختيار'
	],
	selectPlaceholderHint: [
		'例：「選んでください」。空欄のときは、最初の選択肢が選ばれた状態で表示します。',
		'For example “Choose one”. Left empty, the first option shows as chosen.',
		'Zum Beispiel „Bitte wählen“. Leer: Die erste Option erscheint ausgewählt.',
		'مثل «اختر». إذا تُرك فارغًا، يظهر الخيار الأول محددًا.'
	],
	required: [
		'この画面では必須にする',
		'Required on this screen',
		'Auf dieser Seite erforderlich',
		'مطلوب في هذه الشاشة'
	],
	requiredBySchema: [
		'登録時に必須かどうかは Identity Schema で決まります。',
		'Whether it is required at sign-up is set in the Identity Schema.',
		'Ob es bei der Registrierung erforderlich ist, legt das Identity Schema fest.',
		'يُحدَّد الإلزام عند التسجيل في مخطط الهوية.'
	],
	authMethod: ['認証方式', 'Authentication method', 'Anmeldeverfahren', 'طريقة المصادقة'],
	actionText: [
		'ログインの文言を付ける',
		'Add sign-in text',
		'Anmeldetext hinzufügen',
		'إضافة نص تسجيل الدخول'
	],
	codeType: ['コードの種類', 'Code type', 'Code-Typ', 'نوع الرمز'],
	codeAuto: ['自動', 'Automatic', 'Automatisch', 'تلقائي'],
	description: ['説明文', 'Description', 'Beschreibung', 'الوصف'],
	supporting: [
		'補足テキスト（任意）',
		'Supporting text (optional)',
		'Zusatztext (optional)',
		'نص إضافي (اختياري)'
	],
	body: ['本文', 'Text', 'Text', 'النص'],
	href: ['リンク先', 'Link destination', 'Linkziel', 'وجهة الرابط'],
	hrefHint: [
		'#見出し、/相対パス、https:// のいずれか',
		'An #anchor, a /relative path or an https:// address',
		'Ein #Anker, ein /relativer Pfad oder eine https://-Adresse',
		'#مرساة أو /مسار نسبي أو عنوان https://'
	],
	captcha: [
		'CAPTCHA の表示',
		'When the CAPTCHA shows',
		'Wann das CAPTCHA erscheint',
		'متى يظهر CAPTCHA'
	],
	captchaInitial: ['最初から表示', 'From the start', 'Von Anfang an', 'من البداية'],
	captchaSubmit: ['送信するとき', 'On submit', 'Beim Absenden', 'عند الإرسال'],
	dividerLabel: [
		'ラベル（任意）',
		'Label (optional)',
		'Beschriftung (optional)',
		'التسمية (اختياري)'
	],
	dividerHint: [
		'例：「または」。空欄のときは、線だけを表示します。',
		'For example “or”. Left empty, only the line shows.',
		'Zum Beispiel „oder“. Leer: Nur die Linie wird angezeigt.',
		'مثل «أو». إذا تُرك فارغًا، يظهر الخط فقط.'
	],
	widgetNote: [
		'この部品は、入力・操作・確認・読み込み中・成功とエラーの表示をまとめて受け持ちます。',
		'This widget handles its own inputs, actions, checks, loading, success and error states.',
		'Dieses Widget übernimmt Eingaben, Aktionen, Prüfungen, Laden, Erfolg und Fehler selbst.',
		'يتولى هذا المكوّن مدخلاته وإجراءاته وتحققه وحالات التحميل والنجاح والخطأ.'
	],
	rowSettings: ['行の設定', 'Row settings', 'Zeilen-Einstellungen', 'إعدادات الصف'],
	rowColumns: ['列の数', 'Columns', 'Spalten', 'الأعمدة'],
	methodPasskey: ['パスキー', 'Passkey', 'Passkey', 'مفتاح المرور'],
	methodMailOtp: [
		'メールのワンタイムコード',
		'Email one-time code',
		'Einmalcode per E-Mail',
		'رمز لمرة واحدة عبر البريد'
	],
	methodMailOtpTotp: [
		'メールのコード＋認証アプリ',
		'Email code + authenticator app',
		'E-Mail-Code + Authenticator-App',
		'رمز البريد + تطبيق المصادقة'
	],
	methodTotp: ['認証アプリ', 'Authenticator app', 'Authenticator-App', 'تطبيق المصادقة'],
	methodExternal: ['外部 IdP', 'External IdP', 'Externer IdP', 'مزوّد هوية خارجي'],
	methodDirectory: [
		'ディレクトリのパスワード',
		'Directory password',
		'Verzeichnispasswort',
		'كلمة مرور الدليل'
	]
} as const satisfies Record<string, Copy>;

export const setting = (key: keyof typeof SETTINGS) => localized(SETTINGS[key]);

export const METHODS = [
	['passkey', 'methodPasskey'],
	['mail_otp', 'methodMailOtp'],
	['mail_otp_totp', 'methodMailOtpTotp'],
	['totp', 'methodTotp'],
	['external_idp', 'methodExternal'],
	['directory_password', 'methodDirectory']
] as const;

export type Method = (typeof METHODS)[number][0];

export interface DisplayCondition {
	mode: 'always' | 'feature_enabled' | 'hidden';
	/** The feature that must be on (with `feature_enabled`). */
	feature: Method;
}

/**
 * Everything a part can be set to (each kind uses its own subset, as in the legacy editor).
 * Names in the comments are the ScreenField properties they map to.
 */
export interface PartSettings {
	/** display_condition */
	condition: DisplayCondition;
	/**
	 * Input parts: store the answer in a user attribute (`field`), or keep it on the screen.
	 * TODO(api): new ScreenField.store_to_profile (default true).
	 * TODO(runtime): when false, `field` is a key local to the screen: never written to the
	 * user profile, not validated against the schema. Where the answer goes is still open
	 * (flow context for later steps, audit event, webhook payload) - decide before shipping.
	 */
	linked: boolean;
	/** field (an Identity Schema field_key when linked). */
	field: string;
	/**
	 * identity_field, select, radio: off hides the label on screen.
	 * TODO(api): new ScreenField.show_label (default true).
	 * TODO(runtime): the Login UI keeps the label in the DOM, visually hidden (sr-only) and
	 * still tied to the control, so screen readers read it; never drop it.
	 */
	showLabel: boolean;
	/** placeholder */
	placeholder: string;
	/**
	 * select, radio when not linked (linked ones use the schema's values).
	 * TODO(api): new ScreenField.options [{ value, label }]; values unique per part; labels
	 * translated in ScreenLocalization.fields[block_id].options[value].
	 * TODO(runtime): check a submitted value is one of these on the server, as the schema
	 * does for linked attributes (write-validator checks enum_values today).
	 */
	options: { value: string; label: string }[];
	/** help_text */
	helpText: string;
	/**
	 * input parts, consent_widget. The schema's registration_required overrides it at runtime
	 * (applyRegistrationSchemaRequirements in ar-auth/src/login-runtime-flow.ts).
	 */
	required: boolean;
	/** auth_widget */
	method: Method;
	actionText: boolean;
	/** code_input_widget */
	codeMode: 'auto' | 'mail_otp' | 'totp';
	/** heading (supporting text), text (body), code input and consent (description), security check (display text) */
	text: string;
	/**
	 * link.
	 * TODO(api): accept only https:// or a path on the same site (no javascript:, data:), on
	 * save and again when rendering.
	 */
	href: string;
	/** security_verification */
	timing: 'initial' | 'submit';
}

export const defaultSettings = (overrides: Partial<PartSettings> = {}): PartSettings => ({
	condition: { mode: 'always', feature: 'passkey' },
	linked: true,
	field: 'email',
	showLabel: true,
	placeholder: '',
	options: [],
	helpText: '',
	required: false,
	method: 'passkey',
	actionText: false,
	codeMode: 'auto',
	text: '',
	href: '',
	timing: 'initial',
	...overrides
});

/** Input parts whose label can be hidden (a checkbox's label is its text, so it stays). */
export const LABEL_KINDS = new Set(['identity_field', 'select', 'radio']);

/** Mirrors custom_claim_schemas.field_type ('string' | 'number' | 'boolean' | 'date' | 'enum'). */
export type SchemaType = 'String' | 'Number' | 'Boolean' | 'Date' | 'Enum';

export interface SchemaField {
	key: string;
	type: SchemaType;
	/**
	 * Enum attributes: the values allowed, with their labels, translated on the schema.
	 * TODO(api): only the values exist today (validation_rules.enum_values); labels and their
	 * translations per value need to be added (see the note at the top of this file).
	 */
	choices?: readonly { value: string; label: Copy }[];
}

/** Demo Identity Schema: attribute keys, their types, and the allowed values where fixed. */
export const SCHEMA_FIELDS: readonly SchemaField[] = [
	{ key: 'email', type: 'String' },
	{ key: 'name', type: 'String' },
	{ key: 'given_name', type: 'String' },
	{ key: 'family_name', type: 'String' },
	{ key: 'preferred_username', type: 'String' },
	{ key: 'phone_number', type: 'String' },
	{ key: 'birthdate', type: 'Date' },
	{ key: 'birth_year', type: 'Number' },
	{
		key: 'country',
		type: 'Enum',
		choices: [
			{ value: 'jp', label: ['日本', 'Japan', 'Japan', 'اليابان'] },
			{
				value: 'us',
				label: ['アメリカ合衆国', 'United States', 'Vereinigte Staaten', 'الولايات المتحدة']
			},
			{ value: 'de', label: ['ドイツ', 'Germany', 'Deutschland', 'ألمانيا'] },
			{ value: 'fr', label: ['フランス', 'France', 'Frankreich', 'فرنسا'] }
		]
	},
	{
		key: 'gender',
		type: 'Enum',
		choices: [
			{ value: 'female', label: ['女性', 'Female', 'Weiblich', 'أنثى'] },
			{ value: 'male', label: ['男性', 'Male', 'Männlich', 'ذكر'] },
			{ value: 'other', label: ['その他', 'Other', 'Divers', 'آخر'] },
			{
				value: 'unspecified',
				label: ['回答しない', 'Prefer not to say', 'Keine Angabe', 'أفضل عدم الإجابة']
			}
		]
	},
	{ key: 'news_opt_in', type: 'Boolean' },
	{ key: 'terms_accepted', type: 'Boolean' }
];

/**
 * The attribute types a part can store: a checkbox yes/no, choices an enum, a field the rest.
 * TODO(api): the Admin API must apply the same rules when a screen is saved.
 */
export const SCHEMA_TYPES_FOR: Record<string, readonly SchemaType[]> = {
	identity_field: ['String', 'Number', 'Date'],
	select: ['Enum'],
	radio: ['Enum'],
	checkbox: ['Boolean']
};

/** Parts that offer choices: stored to the profile, their values come from an enum attribute. */
export const CHOICE_KINDS = new Set(['select', 'radio']);

/** Whether a part can store its answer in an attribute. */
export const fieldFits = (kind: string, field: SchemaField) =>
	(SCHEMA_TYPES_FOR[kind] ?? []).includes(field.type);

/** The allowed values of an attribute, labelled in the current language. */
export const schemaChoices = (key: string) =>
	(SCHEMA_FIELDS.find((field) => field.key === key)?.choices ?? []).map((choice) => ({
		value: choice.value,
		label: localized(choice.label)
	}));

/**
 * The options a choice part shows: the schema's when linked, its own otherwise.
 * TODO(runtime): the Login UI resolves linked options the same way at request time, from the
 * schema in the screen payload (never from a copy saved with the screen).
 */
export const choicesOf = (settings: PartSettings | undefined) =>
	!settings ? [] : settings.linked ? schemaChoices(settings.field) : settings.options;

export const ACCOUNT_KINDS = new Set(
	PART_DEFS.filter((def) => def.group === 'account').map((def) => def.kind)
);

/** Settings a new part starts with: what it most likely stores, and a few sample options. */
export function kindDefaults(kind: string): Partial<PartSettings> {
	if (kind === 'checkbox') return { field: 'news_opt_in' };
	if (kind === 'select' || kind === 'radio') {
		// Linked: the schema's values. The own list is used once unlinked (a question kept
		// on this screen only, such as how people heard of the service).
		return {
			field: kind === 'radio' ? 'gender' : 'country',
			options: [
				{
					value: 'web',
					label: localized(['Web 検索', 'Web search', 'Websuche', 'البحث على الويب'])
				},
				{ value: 'friend', label: localized(['知人の紹介', 'A friend', 'Empfehlung', 'صديق']) },
				{ value: 'event', label: localized(['イベント', 'An event', 'Veranstaltung', 'فعالية']) }
			]
		};
	}
	return {};
}
