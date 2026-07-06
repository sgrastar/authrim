import { Context } from 'hono';
import type {
  Env,
  FormProfileField,
  FormProfileKind,
  FormProfileLocalization,
  FormProfileResponse,
  FormProfileSettings,
} from '@authrim/ar-lib-core';
import { createAuthContextFromHono, getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env }>;
type Row = Record<string, unknown>;

const FORM_KINDS = new Set<FormProfileKind>([
  'registration',
  'profile_completion',
  'login',
  'consent',
  'code_input',
  'custom',
]);
const FORM_BLOCK_TYPES = new Set([
  'identity_field',
  'auth_widget',
  'code_input_widget',
  'consent_widget',
  'heading',
  'text',
  'security_verification',
  'divider',
  'layout_row',
]);
const FORM_VALUE_TYPES = new Set(['text', 'boolean']);
const FORM_HUMAN_VERIFICATION_TIMINGS = new Set(['initial', 'submit']);
const FORM_CODE_INPUT_MODES = new Set(['auto', 'mail_otp', 'totp']);

type FormLocalizationLanguage =
  | 'en'
  | 'ja'
  | 'zh_CN'
  | 'zh_TW'
  | 'es'
  | 'pt'
  | 'fr'
  | 'de'
  | 'ko'
  | 'ru'
  | 'id';

type LocalizedText = Record<FormLocalizationLanguage, string>;

const FORM_LOCALIZATION_LANGUAGES: FormLocalizationLanguage[] = [
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
  'id',
];

const FORM_TEXT_LOCALIZATIONS: Record<string, LocalizedText> = {
  Registration: {
    en: 'Registration',
    ja: '新規登録',
    zh_CN: '注册',
    zh_TW: '註冊',
    es: 'Registro',
    pt: 'Registro',
    fr: 'Inscription',
    de: 'Registrierung',
    ko: '등록',
    ru: 'Регистрация',
    id: 'Pendaftaran',
  },
  'Profile completion': {
    en: 'Profile completion',
    ja: 'プロフィール追加入力',
    zh_CN: '完善个人资料',
    zh_TW: '完善個人資料',
    es: 'Completar perfil',
    pt: 'Conclusão do perfil',
    fr: 'Compléter le profil',
    de: 'Profil vervollständigen',
    ko: '프로필 추가 입력',
    ru: 'Заполнение профиля',
    id: 'Pelengkapan profil',
  },
  Login: {
    en: 'Login',
    ja: 'ログイン',
    zh_CN: '登录',
    zh_TW: '登入',
    es: 'Inicio de sesión',
    pt: 'Login',
    fr: 'Connexion',
    de: 'Anmeldung',
    ko: '로그인',
    ru: 'Вход',
    id: 'Masuk',
  },
  Consent: {
    en: 'Consent',
    ja: '同意',
    zh_CN: '同意',
    zh_TW: '同意',
    es: 'Consentimiento',
    pt: 'Consentimento',
    fr: 'Consentement',
    de: 'Einwilligung',
    ko: '동의',
    ru: 'Согласие',
    id: 'Persetujuan',
  },
  'Default registration form.': {
    en: 'Default registration form.',
    ja: '標準の新規登録フォームです。',
    zh_CN: '默认注册表单。',
    zh_TW: '預設註冊表單。',
    es: 'Formulario de registro predeterminado.',
    pt: 'Formulário de registro padrão.',
    fr: "Formulaire d'inscription par défaut.",
    de: 'Standardformular für die Registrierung.',
    ko: '기본 등록 양식입니다.',
    ru: 'Форма регистрации по умолчанию.',
    id: 'Formulir pendaftaran default.',
  },
  'Default profile completion form.': {
    en: 'Default profile completion form.',
    ja: '標準のプロフィール追加入力フォームです。',
    zh_CN: '默认的个人资料补充表单。',
    zh_TW: '預設的個人資料補充表單。',
    es: 'Formulario predeterminado para completar el perfil.',
    pt: 'Formulário padrão de conclusão do perfil.',
    fr: 'Formulaire par défaut pour compléter le profil.',
    de: 'Standardformular zum Vervollständigen des Profils.',
    ko: '기본 프로필 추가 입력 양식입니다.',
    ru: 'Форма заполнения профиля по умолчанию.',
    id: 'Formulir pelengkapan profil default.',
  },
  'Default login form.': {
    en: 'Default login form.',
    ja: '標準のログインフォームです。',
    zh_CN: '默认登录表单。',
    zh_TW: '預設登入表單。',
    es: 'Formulario de inicio de sesión predeterminado.',
    pt: 'Formulário de login padrão.',
    fr: 'Formulaire de connexion par défaut.',
    de: 'Standardformular für die Anmeldung.',
    ko: '기본 로그인 양식입니다.',
    ru: 'Форма входа по умолчанию.',
    id: 'Formulir masuk default.',
  },
  'Code input': {
    en: 'Code input',
    ja: 'コード入力',
    zh_CN: '代码输入',
    zh_TW: '代碼輸入',
    es: 'Entrada de código',
    pt: 'Entrada de código',
    fr: 'Saisie du code',
    de: 'Codeeingabe',
    ko: '코드 입력',
    ru: 'Ввод кода',
    id: 'Input kode',
  },
  'Default code input form.': {
    en: 'Default code input form.',
    ja: '標準のコード入力フォームです。',
    zh_CN: '默认代码输入表单。',
    zh_TW: '預設代碼輸入表單。',
    es: 'Formulario predeterminado de entrada de código.',
    pt: 'Formulário padrão de entrada de código.',
    fr: 'Formulaire de saisie du code par défaut.',
    de: 'Standardformular für die Codeeingabe.',
    ko: '기본 코드 입력 양식입니다.',
    ru: 'Форма ввода кода по умолчанию.',
    id: 'Formulir input kode default.',
  },
  'Default login helper form.': {
    en: 'Default login helper form.',
    ja: '標準のログイン補助フォームです。',
    zh_CN: '默认登录辅助表单。',
    zh_TW: '預設登入輔助表單。',
    es: 'Formulario auxiliar de inicio de sesión predeterminado.',
    pt: 'Formulário auxiliar de login padrão.',
    fr: 'Formulaire d’aide à la connexion par défaut.',
    de: 'Standardformular für die Anmeldehilfe.',
    ko: '기본 로그인 보조 양식입니다.',
    ru: 'Вспомогательная форма входа по умолчанию.',
    id: 'Formulir bantuan masuk default.',
  },
  'Default consent confirmation form.': {
    en: 'Default consent confirmation form.',
    ja: '標準の同意確認フォームです。',
    zh_CN: '默认同意确认表单。',
    zh_TW: '預設同意確認表單。',
    es: 'Formulario de confirmación de consentimiento predeterminado.',
    pt: 'Formulário padrão de confirmação de consentimento.',
    fr: 'Formulaire de confirmation du consentement par défaut.',
    de: 'Standardformular zur Einwilligungsbestätigung.',
    ko: '기본 동의 확인 양식입니다.',
    ru: 'Форма подтверждения согласия по умолчанию.',
    id: 'Formulir konfirmasi persetujuan default.',
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
    id: 'Buat akun dengan Passkey',
  },
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
    id: 'Masuk dengan Passkey',
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
    id: 'Email',
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
    id: 'Nama',
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
    id: 'Nama depan',
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
    id: 'Nama belakang',
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
    id: 'Nama pengguna pilihan',
  },
  'Send verification code': {
    en: 'Send verification code',
    ja: '認証コードを送信',
    zh_CN: '发送验证码',
    zh_TW: '傳送驗證碼',
    es: 'Enviar código de verificación',
    pt: 'Enviar código de verificação',
    fr: 'Envoyer le code de vérification',
    de: 'Bestätigungscode senden',
    ko: '인증 코드 보내기',
    ru: 'Отправить код подтверждения',
    id: 'Kirim kode verifikasi',
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
    id: 'Kirim kode melalui email',
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
    id: 'OTP email + aplikasi autentikator',
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
    id: 'Masuk dengan aplikasi autentikator',
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
    id: 'Buat akun dengan aplikasi autentikator',
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
    id: 'Kode autentikasi',
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
    id: 'Kode verifikasi email',
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
    id: 'Kode aplikasi autentikator',
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
    id: 'Masukkan kode dari email atau aplikasi autentikator.',
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
    id: 'atau',
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
    id: 'Lanjutkan dengan akun lain',
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
    id: 'Lanjutkan dengan IdP eksternal',
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
    id: 'Ext. IdP',
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
    id: 'Masuk',
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
    id: 'Masuk dengan kata sandi direktori',
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
    id: 'Konfirmasi persetujuan',
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
    id: 'Tinjau item persetujuan yang diperlukan untuk langkah ini.',
  },
  'Security verification': {
    en: 'Security verification',
    ja: 'セキュリティ確認',
    zh_CN: '安全验证',
    zh_TW: '安全驗證',
    es: 'Verificación de seguridad',
    pt: 'Verificação de segurança',
    fr: 'Vérification de sécurité',
    de: 'Sicherheitsprüfung',
    ko: '보안 확인',
    ru: 'Проверка безопасности',
    id: 'Verifikasi keamanan',
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
    id: 'Pemisah',
  },
};

const FORM_TEXT_LOCALIZATION_ALIASES: Partial<
  Record<keyof typeof FORM_TEXT_LOCALIZATIONS, string[]>
> = {
  'Send code by email': ['Send verification code', '認証コードを送信'],
  'Sign in with authenticator app': ['Continue with authenticator app', '認証アプリで続行'],
  'Create account with authenticator app': ['認証アプリでアカウント作成'],
  'Authentication code': ['Code input', 'コード入力'],
  'Ext. IdP': ['Continue with external IdP', 'Sign in with Ext. IdP', 'Ext. IdPでログイン'],
  'Security verification': ['Security check'],
};

const DEFAULT_FORM_PROFILES: Array<{
  profile_key: string;
  display_name: string;
  description: string;
  form_kind: FormProfileKind;
  fields: FormProfileField[];
  settings: FormProfileSettings;
}> = [
  {
    profile_key: 'registration',
    display_name: 'Registration',
    description: 'Default registration form.',
    form_kind: 'registration',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'auth.passkey',
        label: 'Create Account with Passkey',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'passkey',
        order: 10,
      },
      {
        field: 'auth.totp',
        label: 'Create account with authenticator app',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'totp',
        order: 15,
      },
      {
        field: 'email',
        label: 'Email',
        required: true,
        block_type: 'identity_field',
        order: 20,
      },
      {
        field: 'name',
        label: 'Name',
        required: false,
        block_type: 'identity_field',
        order: 30,
      },
    ],
  },
  {
    profile_key: 'profile_completion',
    display_name: 'Profile completion',
    description: 'Default profile completion form.',
    form_kind: 'profile_completion',
    settings: { canvas_layout: 'narrow' },
    fields: [
      { field: 'name', label: 'Name', required: true, order: 10 },
      {
        field: 'preferred_username',
        label: 'Preferred username',
        required: false,
        order: 20,
      },
    ],
  },
  {
    profile_key: 'login',
    display_name: 'Login',
    description: 'Default login form.',
    form_kind: 'login',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'auth.passkey',
        label: 'Sign in with Passkey',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'passkey',
        order: 10,
      },
      {
        field: 'divider.or',
        label: 'or',
        required: false,
        block_type: 'divider',
        text: 'or',
        order: 20,
      },
      {
        field: 'auth.mail_otp',
        label: 'Send code by email',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'mail_otp',
        order: 30,
      },
      {
        field: 'auth.totp',
        label: 'Sign in with authenticator app',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'totp',
        order: 35,
      },
      {
        field: 'divider.other_accounts',
        label: 'Continue with another account',
        required: false,
        block_type: 'divider',
        text: 'Continue with another account',
        order: 40,
      },
      {
        field: 'auth.external_idp',
        label: 'Ext. IdP',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'external_idp',
        external_idp_show_action_text: false,
        order: 50,
      },
      {
        field: 'auth.directory_password',
        label: 'Sign in with directory password',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'directory_password',
        order: 60,
      },
    ],
  },
  {
    profile_key: 'code_input',
    display_name: 'Code input',
    description: 'Default code input form.',
    form_kind: 'code_input',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'auth.code_input',
        label: 'Authentication code',
        required: true,
        block_type: 'code_input_widget',
        auth_method: 'mail_otp',
        code_input_mode: 'auto',
        text: 'Enter the code from your email or authenticator app.',
        order: 10,
      },
    ],
  },
  {
    profile_key: 'consent',
    display_name: 'Consent',
    description: 'Default consent confirmation form.',
    form_kind: 'consent',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'consent.policy',
        label: 'Consent confirmation',
        required: true,
        block_type: 'consent_widget',
        text: 'Review the consent items required for this step.',
        order: 10,
      },
    ],
  },
];

function invalid(c: AdminContext, error_description: string): Response {
  return c.json({ error: 'invalid_request', error_description }, 400);
}

function notFound(c: AdminContext, error_description: string): Response {
  return c.json({ error: 'not_found', error_description }, 404);
}

function nowMs(): number {
  return Date.now();
}

function readTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProfileKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function readBlockType(value: unknown): FormProfileField['block_type'] {
  return typeof value === 'string' && FORM_BLOCK_TYPES.has(value)
    ? (value as FormProfileField['block_type'])
    : 'identity_field';
}

function readValueType(value: unknown): FormProfileField['value_type'] {
  return typeof value === 'string' && FORM_VALUE_TYPES.has(value)
    ? (value as FormProfileField['value_type'])
    : undefined;
}

function readHumanVerificationTiming(
  value: unknown
): FormProfileField['human_verification_timing'] {
  return typeof value === 'string' && FORM_HUMAN_VERIFICATION_TIMINGS.has(value)
    ? (value as FormProfileField['human_verification_timing'])
    : undefined;
}

function readCodeInputMode(value: unknown): FormProfileField['code_input_mode'] {
  return typeof value === 'string' && FORM_CODE_INPUT_MODES.has(value)
    ? (value as FormProfileField['code_input_mode'])
    : undefined;
}

function readPositiveInteger(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > max) return undefined;
  return value;
}

function normalizeSettings(value: unknown): FormProfileSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { canvas_layout: 'narrow' };
  }
  const record = value as Row;
  return {
    canvas_layout: record.canvas_layout === 'wide' ? 'wide' : 'narrow',
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeFields(value: unknown): FormProfileField[] | null {
  if (!Array.isArray(value)) return null;
  const fields: FormProfileField[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Row;
    const field = readTrimmed(record.field);
    const label = readTrimmed(record.label);
    if (!field || !label) return null;
    fields.push({
      field,
      label,
      required: readBoolean(record.required, false),
      block_type: readBlockType(record.block_type),
      block_id: readTrimmed(record.block_id) ?? undefined,
      value_type: readValueType(record.value_type),
      auth_method: readTrimmed(record.auth_method),
      code_input_mode: readCodeInputMode(record.code_input_mode),
      external_idp_show_action_text:
        record.external_idp_show_action_text === undefined
          ? undefined
          : readBoolean(record.external_idp_show_action_text, false),
      text: readTrimmed(record.text),
      help_text: readTrimmed(record.help_text),
      placeholder: readTrimmed(record.placeholder),
      human_verification_timing: readHumanVerificationTiming(record.human_verification_timing),
      layout_columns: readPositiveInteger(record.layout_columns, 4),
      layout_column: readPositiveInteger(record.layout_column, 4),
      order:
        typeof record.order === 'number' && Number.isInteger(record.order)
          ? record.order
          : undefined,
    });
  }
  return fields;
}

function normalizeLocalizations(value: unknown): Record<string, FormProfileLocalization> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, FormProfileLocalization>;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function localizedText(
  value: string | null | undefined,
  language: FormLocalizationLanguage
): string {
  if (!value) return '';
  return FORM_TEXT_LOCALIZATIONS[value]?.[language] ?? value;
}

function defaultTextValuesForSource(source: string): Set<string> {
  const localizations = FORM_TEXT_LOCALIZATIONS[source];
  if (!localizations) return new Set([source]);
  return new Set([
    source,
    ...Object.values(localizations),
    ...(FORM_TEXT_LOCALIZATION_ALIASES[source] ?? []),
  ]);
}

function mergeLocalizedDefaultValue(
  current: string | null | undefined,
  source: string | null | undefined,
  language: FormLocalizationLanguage
): string | undefined {
  if (!source) return current ?? undefined;
  const localized = localizedText(source, language);
  const defaultEnglish = localizedText(source, 'en');
  if (
    !current ||
    current === source ||
    current === defaultEnglish ||
    defaultTextValuesForSource(source).has(current)
  ) {
    return localized;
  }
  return current;
}

function defaultLocalizationKey(field: FormProfileField, index: number): string {
  return field.block_id ?? `${field.field}-${index}`;
}

function mergeDefaultFormProfileLocalizations(
  profile: (typeof DEFAULT_FORM_PROFILES)[number],
  fields: FormProfileField[],
  current: Record<string, FormProfileLocalization>
): Record<string, FormProfileLocalization> {
  const next: Record<string, FormProfileLocalization> = { ...current };
  for (const language of FORM_LOCALIZATION_LANGUAGES) {
    const existing = next[language] ?? {};
    const existingFields = existing.fields ?? {};
    const mergedFields: NonNullable<FormProfileLocalization['fields']> = { ...existingFields };

    for (const [index, field] of fields.entries()) {
      const defaultField = profile.fields[index];
      const key = defaultLocalizationKey(field, index);
      const fieldLocalization = { ...(mergedFields[key] ?? {}) };
      const label = mergeLocalizedDefaultValue(
        fieldLocalization.label,
        defaultField?.label ?? field.label,
        language
      );
      const text = mergeLocalizedDefaultValue(
        fieldLocalization.text,
        defaultField?.text ?? field.text,
        language
      );
      const helpText = mergeLocalizedDefaultValue(
        fieldLocalization.help_text,
        defaultField?.help_text ?? field.help_text,
        language
      );
      const placeholder = mergeLocalizedDefaultValue(
        fieldLocalization.placeholder,
        defaultField?.placeholder ?? field.placeholder,
        language
      );
      if (label) {
        fieldLocalization.label = label;
      }
      if (text) {
        fieldLocalization.text = text;
      }
      if (helpText) {
        fieldLocalization.help_text = helpText;
      }
      if (placeholder) {
        fieldLocalization.placeholder = placeholder;
      }
      if (Object.keys(fieldLocalization).length > 0) {
        mergedFields[key] = fieldLocalization;
      }
    }

    next[language] = {
      ...existing,
      display_name: mergeLocalizedDefaultValue(
        existing.display_name,
        profile.display_name,
        language
      ),
      description: mergeLocalizedDefaultValue(existing.description, profile.description, language),
      fields: mergedFields,
    };
  }
  return next;
}

function toResponse(row: Row): FormProfileResponse {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    profile_key: String(row.profile_key),
    display_name: String(row.display_name),
    description: typeof row.description === 'string' ? row.description : null,
    form_kind: String(row.form_kind) as FormProfileKind,
    fields: parseJson<FormProfileField[]>(row.fields_json, []),
    localizations: parseJson<Record<string, FormProfileLocalization>>(row.localizations_json, {}),
    settings: normalizeSettings(parseJson<FormProfileSettings | null>(row.settings_json, null)),
    is_active: row.is_active as number | boolean,
    is_system: row.is_system as number | boolean,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

async function ensureDefaultFormProfiles(c: AdminContext, tenantId: string): Promise<void> {
  const authCtx = createAuthContextFromHono(c, tenantId);
  for (const profile of DEFAULT_FORM_PROFILES) {
    const existing = await authCtx.coreAdapter.queryOne<Row>(
      `SELECT id, form_kind, fields_json, localizations_json, is_system
         FROM form_profiles
        WHERE tenant_id = ? AND profile_key = ?`,
      [tenantId, profile.profile_key]
    );
    if (existing) {
      if (readBoolean(existing.is_system, false)) {
        const fields = parseJson<FormProfileField[]>(existing.fields_json, profile.fields);
        const currentLocalizations = parseJson<Record<string, FormProfileLocalization>>(
          existing.localizations_json,
          {}
        );
        const mergedLocalizations = mergeDefaultFormProfileLocalizations(
          profile,
          fields.length > 0 ? fields : profile.fields,
          currentLocalizations
        );
        if (serializeJson(mergedLocalizations) !== serializeJson(currentLocalizations)) {
          await authCtx.coreAdapter.execute(
            `UPDATE form_profiles
                SET localizations_json = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
            [serializeJson(mergedLocalizations), nowMs(), tenantId, existing.id]
          );
        }
        if (existing.form_kind !== profile.form_kind) {
          await authCtx.coreAdapter.execute(
            `UPDATE form_profiles
                SET form_kind = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
            [profile.form_kind, nowMs(), tenantId, existing.id]
          );
        }
      }
      continue;
    }
    await authCtx.coreAdapter.execute(
      `INSERT INTO form_profiles
       (id, tenant_id, profile_key, display_name, description, form_kind, fields_json,
        localizations_json, settings_json, is_active, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        profile.profile_key,
        profile.display_name,
        profile.description,
        profile.form_kind,
        serializeJson(profile.fields),
        serializeJson(mergeDefaultFormProfileLocalizations(profile, profile.fields, {})),
        serializeJson(profile.settings),
        1,
        1,
        nowMs(),
        nowMs(),
      ]
    );
  }
}

export async function adminFormProfilesListHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    await ensureDefaultFormProfiles(c, tenantId);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM form_profiles
       WHERE tenant_id = ?
       ORDER BY is_system DESC, form_kind ASC, display_name ASC`,
      [tenantId]
    );
    return c.json({ profiles: (rows as Row[]).map(toResponse) });
  } catch (error) {
    log.error('Failed to list form profiles', { action: 'list' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list form profiles' },
      500
    );
  }
}

export async function adminFormProfileGetHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, c.req.param('id')]
    );
    if (!row) return notFound(c, 'Form profile not found');
    return c.json({ profile: toResponse(row) });
  } catch (error) {
    log.error('Failed to get form profile', { action: 'get' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to get form profile' }, 500);
  }
}

export async function adminFormProfileCreateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const body = await c.req.json<Row>();
    const displayName = readTrimmed(body.display_name);
    const rawKey = readTrimmed(body.profile_key) ?? displayName;
    const profileKey = rawKey ? normalizeProfileKey(rawKey) : '';
    const formKind = body.form_kind;
    const fields = normalizeFields(body.fields);
    if (!displayName) return invalid(c, 'display_name is required');
    if (!profileKey) return invalid(c, 'profile_key is required');
    if (!FORM_KINDS.has(formKind as FormProfileKind)) return invalid(c, 'Invalid form_kind');
    if (!fields || fields.length === 0) return invalid(c, 'fields must contain at least one field');

    const now = nowMs();
    const id = crypto.randomUUID();
    await authCtx.coreAdapter.execute(
      `INSERT INTO form_profiles
       (id, tenant_id, profile_key, display_name, description, form_kind, fields_json,
        localizations_json, settings_json, is_active, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        profileKey,
        displayName,
        readTrimmed(body.description),
        formKind,
        serializeJson(fields),
        serializeJson(normalizeLocalizations(body.localizations)),
        serializeJson(normalizeSettings(body.settings)),
        readBoolean(body.is_active, true) ? 1 : 0,
        0,
        now,
        now,
      ]
    );
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return c.json({ profile: row ? toResponse(row) : null }, 201);
  } catch (error) {
    log.error('Failed to create form profile', { action: 'create' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to create form profile' },
      500
    );
  }
}

export async function adminFormProfileUpdateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existing = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT id, is_system FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    if (!existing) return notFound(c, 'Form profile not found');
    const body = await c.req.json<Row>();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.display_name !== undefined) {
      const displayName = readTrimmed(body.display_name);
      if (!displayName) return invalid(c, 'display_name is required');
      sets.push('display_name = ?');
      params.push(displayName);
    }
    if (body.description !== undefined) {
      sets.push('description = ?');
      params.push(readTrimmed(body.description));
    }
    if (body.form_kind !== undefined) {
      if (!FORM_KINDS.has(body.form_kind as FormProfileKind))
        return invalid(c, 'Invalid form_kind');
      sets.push('form_kind = ?');
      params.push(body.form_kind);
    }
    if (body.fields !== undefined) {
      const fields = normalizeFields(body.fields);
      if (!fields || fields.length === 0) {
        return invalid(c, 'fields must contain at least one field');
      }
      sets.push('fields_json = ?');
      params.push(serializeJson(fields));
    }
    if (body.localizations !== undefined) {
      sets.push('localizations_json = ?');
      params.push(serializeJson(normalizeLocalizations(body.localizations)));
    }
    if (body.settings !== undefined) {
      sets.push('settings_json = ?');
      params.push(serializeJson(normalizeSettings(body.settings)));
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?');
      params.push(readBoolean(body.is_active, true) ? 1 : 0);
    }
    if (sets.length === 0) return invalid(c, 'No fields to update');
    sets.push('updated_at = ?');
    params.push(nowMs(), tenantId, id);
    await authCtx.coreAdapter.execute(
      `UPDATE form_profiles SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
      params
    );
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return c.json({ profile: row ? toResponse(row) : null });
  } catch (error) {
    log.error('Failed to update form profile', { action: 'update' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to update form profile' },
      500
    );
  }
}

export async function adminFormProfileDeleteHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existing = await authCtx.coreAdapter.queryOne<{ is_system: number | boolean }>(
      'SELECT is_system FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    if (!existing) return notFound(c, 'Form profile not found');
    if (readBoolean(existing.is_system, false))
      return invalid(c, 'System form profiles cannot be deleted');
    await authCtx.coreAdapter.execute('DELETE FROM form_profiles WHERE tenant_id = ? AND id = ?', [
      tenantId,
      id,
    ]);
    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete form profile', { action: 'delete' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to delete form profile' },
      500
    );
  }
}
