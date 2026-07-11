export const SCREEN_LOCALIZATION_LANGUAGES = [
	'en',
	'ja',
	'zh_CN',
	'zh_TW',
	'es',
	'pt',
	'fr',
	'de',
	'ko',
	'ru',
	'id'
] as const;

export type ScreenLocalizationLanguage = (typeof SCREEN_LOCALIZATION_LANGUAGES)[number];
type LocalizedText = Record<ScreenLocalizationLanguage, string>;

const SCREEN_TEXT_LOCALIZATIONS: Record<string, LocalizedText> = {
	'Sign in with Passkey': {
		en: 'Sign in with Passkey',
		ja: 'Passkeyでサインイン',
		zh_CN: '使用 Passkey 登录',
		zh_TW: '使用 Passkey 登入',
		es: 'Iniciar sesión con Passkey',
		pt: 'Entrar com Passkey',
		fr: 'Se connecter avec Passkey',
		de: 'Mit Passkey anmelden',
		ko: 'Passkey로 로그인',
		ru: 'Войти с Passkey',
		id: 'Masuk dengan Passkey'
	},
	'Create Account with Passkey': {
		en: 'Create Account with Passkey',
		ja: 'Passkeyでアカウント作成',
		zh_CN: '使用 Passkey 创建账户',
		zh_TW: '使用 Passkey 建立帳戶',
		es: 'Crear cuenta con Passkey',
		pt: 'Criar conta com Passkey',
		fr: 'Créer un compte avec Passkey',
		de: 'Konto mit Passkey erstellen',
		ko: 'Passkey로 계정 만들기',
		ru: 'Создать аккаунт с Passkey',
		id: 'Buat akun dengan Passkey'
	},
	'Create your account': {
		en: 'Create your account',
		ja: 'アカウントを作成',
		zh_CN: '创建你的账户',
		zh_TW: '建立你的帳戶',
		es: 'Crea tu cuenta',
		pt: 'Crie sua conta',
		fr: 'Créez votre compte',
		de: 'Konto erstellen',
		ko: '계정 만들기',
		ru: 'Создайте учетную запись',
		id: 'Buat akun Anda'
	},
	'Send code by email': {
		en: 'Send code by email',
		ja: '認証コードをメール送信',
		zh_CN: '通过电子邮件发送验证码',
		zh_TW: '透過電子郵件傳送驗證碼',
		es: 'Enviar código por correo electrónico',
		pt: 'Enviar código por e-mail',
		fr: 'Envoyer le code par e-mail',
		de: 'Code per E-Mail senden',
		ko: '이메일로 인증 코드 보내기',
		ru: 'Отправить код по электронной почте',
		id: 'Kirim kode melalui email'
	},
	'Mail OTP + authenticator app': {
		en: 'Mail OTP + authenticator app',
		ja: 'Mail OTP＋認証アプリ',
		zh_CN: '邮件 OTP + 身份验证器应用',
		zh_TW: '郵件 OTP + 驗證器應用程式',
		es: 'OTP por correo + aplicación de autenticación',
		pt: 'OTP por e-mail + app autenticador',
		fr: 'OTP par e-mail + application d’authentification',
		de: 'E-Mail-OTP + Authenticator-App',
		ko: '메일 OTP + 인증 앱',
		ru: 'OTP по email + приложение-аутентификатор',
		id: 'OTP email + aplikasi autentikator'
	},
	'Sign in with authenticator app': {
		en: 'Sign in with authenticator app',
		ja: '認証アプリでログイン',
		zh_CN: '使用身份验证器应用登录',
		zh_TW: '使用驗證器應用程式登入',
		es: 'Iniciar sesión con la aplicación de autenticación',
		pt: 'Entrar com app autenticador',
		fr: 'Se connecter avec l’application d’authentification',
		de: 'Mit Authenticator-App anmelden',
		ko: '인증 앱으로 로그인',
		ru: 'Войти с помощью приложения-аутентификатора',
		id: 'Masuk dengan aplikasi autentikator'
	},
	'Create account with authenticator app': {
		en: 'Create account with authenticator app',
		ja: '認証アプリで新規登録',
		zh_CN: '使用身份验证器应用创建账户',
		zh_TW: '使用驗證器應用程式建立帳戶',
		es: 'Crear cuenta con la aplicación de autenticación',
		pt: 'Criar conta com app autenticador',
		fr: 'Créer un compte avec l’application d’authentification',
		de: 'Konto mit Authenticator-App erstellen',
		ko: '인증 앱으로 계정 만들기',
		ru: 'Создать учетную запись с помощью приложения-аутентификатора',
		id: 'Buat akun dengan aplikasi autentikator'
	},
	'Authentication code': {
		en: 'Authentication code',
		ja: '認証コード',
		zh_CN: '验证码',
		zh_TW: '驗證碼',
		es: 'Código de autenticación',
		pt: 'Código de autenticação',
		fr: 'Code d’authentification',
		de: 'Authentifizierungscode',
		ko: '인증 코드',
		ru: 'Код аутентификации',
		id: 'Kode autentikasi'
	},
	'Enter verification code': {
		en: 'Enter verification code',
		ja: '認証コードを入力',
		zh_CN: '输入验证码',
		zh_TW: '輸入驗證碼',
		es: 'Introduce el código de verificación',
		pt: 'Insira o código de verificação',
		fr: 'Saisissez le code de vérification',
		de: 'Bestätigungscode eingeben',
		ko: '인증 코드를 입력하세요',
		ru: 'Введите код подтверждения',
		id: 'Masukkan kode verifikasi'
	},
	'Email verification code': {
		en: 'Email verification code',
		ja: 'メール認証コード',
		zh_CN: '电子邮件验证码',
		zh_TW: '電子郵件驗證碼',
		es: 'Código de verificación por correo',
		pt: 'Código de verificação por e-mail',
		fr: 'Code de vérification par e-mail',
		de: 'E-Mail-Bestätigungscode',
		ko: '이메일 인증 코드',
		ru: 'Код подтверждения из письма',
		id: 'Kode verifikasi email'
	},
	'Authenticator app code': {
		en: 'Authenticator app code',
		ja: '認証アプリのコード',
		zh_CN: '身份验证器应用代码',
		zh_TW: '驗證器應用程式代碼',
		es: 'Código de la aplicación de autenticación',
		pt: 'Código do app autenticador',
		fr: 'Code de l’application d’authentification',
		de: 'Code aus der Authenticator-App',
		ko: '인증 앱 코드',
		ru: 'Код из приложения-аутентификатора',
		id: 'Kode aplikasi autentikator'
	},
	'Enter the code from your email or authenticator app.': {
		en: 'Enter the code from your email or authenticator app.',
		ja: 'メールまたは認証アプリのコードを入力してください。',
		zh_CN: '请输入电子邮件或身份验证器应用中的验证码。',
		zh_TW: '請輸入電子郵件或驗證器應用程式中的驗證碼。',
		es: 'Introduce el código de tu correo electrónico o de la aplicación de autenticación.',
		pt: 'Insira o código do seu e-mail ou app autenticador.',
		fr: 'Saisissez le code reçu par e-mail ou généré par l’application d’authentification.',
		de: 'Gib den Code aus deiner E-Mail oder Authenticator-App ein.',
		ko: '이메일 또는 인증 앱의 코드를 입력하세요.',
		ru: 'Введите код из письма или приложения-аутентификатора.',
		id: 'Masukkan kode dari email atau aplikasi autentikator.'
	},
	or: {
		en: 'or',
		ja: 'または',
		zh_CN: '或',
		zh_TW: '或',
		es: 'o',
		pt: 'ou',
		fr: 'ou',
		de: 'oder',
		ko: '또는',
		ru: 'или',
		id: 'atau'
	},
	'Continue with another account': {
		en: 'Continue with another account',
		ja: '他のアカウントで続行',
		zh_CN: '使用其他账户继续',
		zh_TW: '使用其他帳戶繼續',
		es: 'Continuar con otra cuenta',
		pt: 'Continuar com outra conta',
		fr: 'Continuer avec un autre compte',
		de: 'Mit einem anderen Konto fortfahren',
		ko: '다른 계정으로 계속',
		ru: 'Продолжить с другой учетной записью',
		id: 'Lanjutkan dengan akun lain'
	},
	'Continue with external IdP': {
		en: 'Continue with external IdP',
		ja: '外部IdPで続行',
		zh_CN: '使用外部 IdP 继续',
		zh_TW: '使用外部 IdP 繼續',
		es: 'Continuar con IdP externo',
		pt: 'Continuar com IdP externo',
		fr: 'Continuer avec un IdP externe',
		de: 'Mit externem IdP fortfahren',
		ko: '외부 IdP로 계속',
		ru: 'Продолжить через внешний IdP',
		id: 'Lanjutkan dengan IdP eksternal'
	},
	'Ext. IdP': {
		en: 'Ext. IdP',
		ja: 'Ext. IdP',
		zh_CN: 'Ext. IdP',
		zh_TW: 'Ext. IdP',
		es: 'Ext. IdP',
		pt: 'Ext. IdP',
		fr: 'Ext. IdP',
		de: 'Ext. IdP',
		ko: 'Ext. IdP',
		ru: 'Ext. IdP',
		id: 'Ext. IdP'
	},
	'Sign in': {
		en: 'Sign in',
		ja: 'ログイン',
		zh_CN: '登录',
		zh_TW: '登入',
		es: 'Iniciar sesión',
		pt: 'Entrar',
		fr: 'Se connecter',
		de: 'Anmelden',
		ko: '로그인',
		ru: 'Войти',
		id: 'Masuk'
	},
	'Sign in with directory password': {
		en: 'Sign in with directory password',
		ja: 'ディレクトリパスワードでサインイン',
		zh_CN: '使用目录密码登录',
		zh_TW: '使用目錄密碼登入',
		es: 'Iniciar sesión con contraseña de directorio',
		pt: 'Entrar com senha do diretório',
		fr: 'Se connecter avec le mot de passe du répertoire',
		de: 'Mit Verzeichnispasswort anmelden',
		ko: '디렉터리 비밀번호로 로그인',
		ru: 'Войти с паролем каталога',
		id: 'Masuk dengan kata sandi direktori'
	},
	Email: {
		en: 'Email',
		ja: 'メールアドレス',
		zh_CN: '电子邮件',
		zh_TW: '電子郵件',
		es: 'Correo electrónico',
		pt: 'E-mail',
		fr: 'Adresse e-mail',
		de: 'E-Mail-Adresse',
		ko: '이메일',
		ru: 'Электронная почта',
		id: 'Email'
	},
	Name: {
		en: 'Name',
		ja: '名前',
		zh_CN: '姓名',
		zh_TW: '姓名',
		es: 'Nombre',
		pt: 'Nome',
		fr: 'Nom',
		de: 'Name',
		ko: '이름',
		ru: 'Имя',
		id: 'Nama'
	},
	'First Name': {
		en: 'First Name',
		ja: '名',
		zh_CN: '名',
		zh_TW: '名字',
		es: 'Nombre',
		pt: 'Nome',
		fr: 'Prénom',
		de: 'Vorname',
		ko: '이름',
		ru: 'Имя',
		id: 'Nama depan'
	},
	'Last Name': {
		en: 'Last Name',
		ja: '姓',
		zh_CN: '姓',
		zh_TW: '姓氏',
		es: 'Apellido',
		pt: 'Sobrenome',
		fr: 'Nom de famille',
		de: 'Nachname',
		ko: '성',
		ru: 'Фамилия',
		id: 'Nama belakang'
	},
	'Preferred username': {
		en: 'Preferred username',
		ja: '希望ユーザー名',
		zh_CN: '首选用户名',
		zh_TW: '偏好的使用者名稱',
		es: 'Nombre de usuario preferido',
		pt: 'Nome de usuário preferido',
		fr: "Nom d'utilisateur préféré",
		de: 'Bevorzugter Benutzername',
		ko: '선호 사용자 이름',
		ru: 'Предпочитаемое имя пользователя',
		id: 'Nama pengguna pilihan'
	},
	'Consent confirmation': {
		en: 'Consent confirmation',
		ja: '同意確認',
		zh_CN: '同意确认',
		zh_TW: '同意確認',
		es: 'Confirmación de consentimiento',
		pt: 'Confirmação de consentimento',
		fr: 'Confirmation du consentement',
		de: 'Einwilligungsbestätigung',
		ko: '동의 확인',
		ru: 'Подтверждение согласия',
		id: 'Konfirmasi persetujuan'
	},
	'Review the consent items required for this step.': {
		en: 'Review the consent items required for this step.',
		ja: 'このステップで必要な同意項目を確認してください。',
		zh_CN: '请确认此步骤所需的同意项目。',
		zh_TW: '請確認此步驟所需的同意項目。',
		es: 'Revisa los elementos de consentimiento requeridos para este paso.',
		pt: 'Revise os itens de consentimento necessários para esta etapa.',
		fr: 'Vérifiez les éléments de consentement requis pour cette étape.',
		de: 'Prüfen Sie die für diesen Schritt erforderlichen Einwilligungen.',
		ko: '이 단계에 필요한 동의 항목을 확인하세요.',
		ru: 'Проверьте пункты согласия, необходимые для этого шага.',
		id: 'Tinjau item persetujuan yang diperlukan untuk langkah ini.'
	},
	'The consent policy selected on the Flow node is rendered here.': {
		en: 'The consent policy selected on the Flow node is rendered here.',
		ja: 'Flowノードで選択した同意ポリシーをここに表示します。',
		zh_CN: '此处显示 Flow 节点中选择的同意策略。',
		zh_TW: '此處會顯示 Flow 節點中選取的同意政策。',
		es: 'Aquí se muestra la política de consentimiento seleccionada en el nodo de Flow.',
		pt: 'A política de consentimento selecionada no nó do Flow é exibida aqui.',
		fr: 'La politique de consentement sélectionnée dans le nœud Flow s’affiche ici.',
		de: 'Die im Flow-Knoten ausgewählte Einwilligungsrichtlinie wird hier angezeigt.',
		ko: 'Flow 노드에서 선택한 동의 정책이 여기에 표시됩니다.',
		ru: 'Здесь отображается политика согласия, выбранная в узле Flow.',
		id: 'Kebijakan persetujuan yang dipilih pada node Flow ditampilkan di sini.'
	},
	'Security check': {
		en: 'Security check',
		ja: 'セキュリティ確認',
		zh_CN: '安全验证',
		zh_TW: '安全驗證',
		es: 'Verificación de seguridad',
		pt: 'Verificação de segurança',
		fr: 'Vérification de sécurité',
		de: 'Sicherheitsprüfung',
		ko: '보안 확인',
		ru: 'Проверка безопасности',
		id: 'Verifikasi keamanan'
	},
	'I am human': {
		en: 'I am human',
		ja: '私は人間です',
		zh_CN: '我是人类',
		zh_TW: '我是人類',
		es: 'Soy humano',
		pt: 'Sou humano',
		fr: 'Je suis humain',
		de: 'Ich bin ein Mensch',
		ko: '저는 사람입니다',
		ru: 'Я человек',
		id: 'Saya manusia'
	},
	Divider: {
		en: 'Divider',
		ja: '区切り線',
		zh_CN: '分隔线',
		zh_TW: '分隔線',
		es: 'Separador',
		pt: 'Divisor',
		fr: 'Séparateur',
		de: 'Trennlinie',
		ko: '구분선',
		ru: 'Разделитель',
		id: 'Pemisah'
	},
	'Layout row': {
		en: 'Layout row',
		ja: 'レイアウト行',
		zh_CN: '布局行',
		zh_TW: '版面列',
		es: 'Fila de diseño',
		pt: 'Linha de layout',
		fr: 'Ligne de mise en page',
		de: 'Layout-Zeile',
		ko: '레이아웃 행',
		ru: 'Строка макета',
		id: 'Baris tata letak'
	},
	Heading: {
		en: 'Heading',
		ja: '見出し',
		zh_CN: '标题',
		zh_TW: '標題',
		es: 'Encabezado',
		pt: 'Cabeçalho',
		fr: 'Titre',
		de: 'Überschrift',
		ko: '제목',
		ru: 'Заголовок',
		id: 'Judul'
	},
	Text: {
		en: 'Text',
		ja: 'テキスト',
		zh_CN: '文本',
		zh_TW: '文字',
		es: 'Texto',
		pt: 'Texto',
		fr: 'Texte',
		de: 'Text',
		ko: '텍스트',
		ru: 'Текст',
		id: 'Teks'
	},
	'Add helper text here.': {
		en: 'Add helper text here.',
		ja: '補足テキストをここに追加します。',
		zh_CN: '在此添加辅助说明文本。',
		zh_TW: '在此加入輔助說明文字。',
		es: 'Agrega texto de ayuda aquí.',
		pt: 'Adicione texto de ajuda aqui.',
		fr: 'Ajoutez le texte d’aide ici.',
		de: 'Füge hier Hilfetext hinzu.',
		ko: '여기에 도움말 텍스트를 추가하세요.',
		ru: 'Добавьте здесь вспомогательный текст.',
		id: 'Tambahkan teks bantuan di sini.'
	}
};

const SCREEN_TEXT_LOCALIZATION_ALIASES: Record<string, string[]> = {
	'Send code by email': ['Send verification code', '認証コードを送信'],
	'Sign in with authenticator app': ['Continue with authenticator app', '認証アプリで続行'],
	'Create account with authenticator app': ['認証アプリでアカウント作成'],
	'Authentication code': ['Code input', 'コード入力'],
	'Ext. IdP': ['Continue with external IdP', 'Sign in with Ext. IdP', 'Ext. IdPでログイン'],
	'Security check': ['Security verification']
};

const canonicalByDefaultText = new Map<string, string>();

for (const [key, localizations] of Object.entries(SCREEN_TEXT_LOCALIZATIONS)) {
	canonicalByDefaultText.set(key, key);
	for (const value of Object.values(localizations)) {
		if (!canonicalByDefaultText.has(value)) canonicalByDefaultText.set(value, key);
	}
	for (const alias of SCREEN_TEXT_LOCALIZATION_ALIASES[key] ?? []) {
		if (!canonicalByDefaultText.has(alias)) canonicalByDefaultText.set(alias, key);
	}
}

export function isDefaultScreenText(value: string | null | undefined): boolean {
	return typeof value === 'string' && canonicalByDefaultText.has(value);
}

export function localizeDefaultScreenText(
	value: string | null | undefined,
	language: ScreenLocalizationLanguage
): string {
	if (!value) return '';
	const canonical = canonicalByDefaultText.get(value) ?? value;
	return SCREEN_TEXT_LOCALIZATIONS[canonical]?.[language] ?? value;
}

export function mergeLocalizedDefaultScreenText(
	current: string | null | undefined,
	source: string | null | undefined,
	language: ScreenLocalizationLanguage
): string {
	if (!source) return current ?? '';
	const localized = localizeDefaultScreenText(source, language);
	const canonical = canonicalByDefaultText.get(source) ?? source;
	const defaults = new Set([
		canonical,
		...Object.values(SCREEN_TEXT_LOCALIZATIONS[canonical] ?? {}),
		...(SCREEN_TEXT_LOCALIZATION_ALIASES[canonical] ?? [])
	]);
	if (!current || defaults.has(current)) return localized;
	return current;
}
