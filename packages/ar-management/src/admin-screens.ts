import { Context } from 'hono';
import type {
  Env,
  ScreenDisplayCondition,
  ScreenField,
  ScreenKind,
  ScreenLocalization,
  ScreenResponse,
  ScreenSettings,
} from '@authrim/ar-lib-core';
import {
  createAuditLogFromContext,
  createAuthContextFromHono,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env }>;
type Row = Record<string, unknown>;

async function recordScreenAudit(
  c: AdminContext,
  event: string,
  screenId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await createAuditLogFromContext(c, event, 'screen', screenId, metadata);
  } catch (error) {
    getLogger(c)
      .module('ADMIN_SCREENS')
      .warn('Failed to record screen audit event', {
        event,
        screen_id: screenId,
        error: error instanceof Error ? error.message : 'unknown',
      });
  }
}

const SCREEN_KINDS = new Set<ScreenKind>([
  'registration',
  'profile_completion',
  'login',
  'consent',
  'code_input',
  'account',
  'custom',
]);
const SCREEN_BLOCK_TYPES = new Set([
  'identity_field',
  'auth_widget',
  'code_input_widget',
  'consent_widget',
  'heading',
  'text',
  'security_verification',
  'divider',
  'layout_row',
  'link',
  'account_profile_widget',
  'account_device_list_widget',
  'account_session_widget',
  'account_passkey_widget',
  'account_totp_widget',
  'account_consent_widget',
  'account_activity_widget',
  'account_social_account_widget',
]);
const ACCOUNT_WIDGET_BLOCK_TYPES = new Set([
  'account_profile_widget',
  'account_device_list_widget',
  'account_session_widget',
  'account_passkey_widget',
  'account_totp_widget',
  'account_consent_widget',
  'account_activity_widget',
  'account_social_account_widget',
]);
const ACCOUNT_SCREEN_BLOCK_TYPES = new Set([
  'layout_row',
  'heading',
  'text',
  'link',
  'divider',
  ...ACCOUNT_WIDGET_BLOCK_TYPES,
]);
const SCREEN_VALUE_TYPES = new Set(['text', 'boolean']);
const SCREEN_HUMAN_VERIFICATION_TIMINGS = new Set(['initial', 'submit']);
const SCREEN_CODE_INPUT_MODES = new Set(['auto', 'mail_otp', 'totp']);
const SCREEN_DISPLAY_CONDITION_MODES = new Set(['always', 'feature_enabled', 'hidden']);
const SCREEN_DISPLAY_CONDITION_FEATURES = new Set([
  'passkey',
  'mail_otp',
  'mail_otp_totp',
  'totp',
  'external_idp',
  'directory_password',
]);

type ScreenLocalizationLanguage =
  | 'en'
  | 'ja'
  | 'zh-CN'
  | 'zh-TW'
  | 'es'
  | 'pt'
  | 'fr'
  | 'de'
  | 'ko'
  | 'ru'
  | 'id';

type LocalizedText = Record<ScreenLocalizationLanguage, string>;

const SCREEN_LOCALIZATION_LANGUAGES: ScreenLocalizationLanguage[] = [
  'en',
  'ja',
  'zh-CN',
  'zh-TW',
  'es',
  'pt',
  'fr',
  'de',
  'ko',
  'ru',
  'id',
];

const SCREEN_TEXT_LOCALIZATIONS: Record<string, LocalizedText> = {
  Registration: {
    en: 'Registration',
    ja: '新規登録',
    'zh-CN': '注册',
    'zh-TW': '註冊',
    es: 'Registro',
    pt: 'Registro',
    fr: 'Inscription',
    de: 'Registrierung',
    ko: '등록',
    ru: 'Регистрация',
    id: 'Pendaftaran',
  },
  'Create your account': {
    en: 'Create your account',
    ja: 'アカウントを作成',
    'zh-CN': '创建你的账户',
    'zh-TW': '建立你的帳戶',
    es: 'Crea tu cuenta',
    pt: 'Crie sua conta',
    fr: 'Créez votre compte',
    de: 'Konto erstellen',
    ko: '계정 만들기',
    ru: 'Создайте учетную запись',
    id: 'Buat akun Anda',
  },
  'Profile completion': {
    en: 'Profile completion',
    ja: 'プロフィール追加入力',
    'zh-CN': '完善个人资料',
    'zh-TW': '完善個人資料',
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
    'zh-CN': '登录',
    'zh-TW': '登入',
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
    'zh-CN': '同意',
    'zh-TW': '同意',
    es: 'Consentimiento',
    pt: 'Consentimento',
    fr: 'Consentement',
    de: 'Einwilligung',
    ko: '동의',
    ru: 'Согласие',
    id: 'Persetujuan',
  },
  'Default registration screen.': {
    en: 'Default registration screen.',
    ja: '標準の新規登録スクリーンです。',
    'zh-CN': '默认注册表单。',
    'zh-TW': '預設註冊表單。',
    es: 'Formulario de registro predeterminado.',
    pt: 'Formulário de registro padrão.',
    fr: "Formulaire d'inscription par défaut.",
    de: 'Standardformular für die Registrierung.',
    ko: '기본 등록 양식입니다.',
    ru: 'Форма регистрации по умолчанию.',
    id: 'Formulir pendaftaran default.',
  },
  'Default profile completion screen.': {
    en: 'Default profile completion screen.',
    ja: '標準のプロフィール追加入力スクリーンです。',
    'zh-CN': '默认的个人资料补充表单。',
    'zh-TW': '預設的個人資料補充表單。',
    es: 'Formulario predeterminado para completar el perfil.',
    pt: 'Formulário padrão de conclusão do perfil.',
    fr: 'Formulaire par défaut pour compléter le profil.',
    de: 'Standardformular zum Vervollständigen des Profils.',
    ko: '기본 프로필 추가 입력 양식입니다.',
    ru: 'Форма заполнения профиля по умолчанию.',
    id: 'Formulir pelengkapan profil default.',
  },
  'Default login screen.': {
    en: 'Default login screen.',
    ja: '標準のログインスクリーンです。',
    'zh-CN': '默认登录表单。',
    'zh-TW': '預設登入表單。',
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
    'zh-CN': '代码输入',
    'zh-TW': '代碼輸入',
    es: 'Entrada de código',
    pt: 'Entrada de código',
    fr: 'Saisie du code',
    de: 'Codeeingabe',
    ko: '코드 입력',
    ru: 'Ввод кода',
    id: 'Input kode',
  },
  'Default code input screen.': {
    en: 'Default code input screen.',
    ja: '標準のコード入力スクリーンです。',
    'zh-CN': '默认代码输入表单。',
    'zh-TW': '預設代碼輸入表單。',
    es: 'Formulario predeterminado de entrada de código.',
    pt: 'Formulário padrão de entrada de código.',
    fr: 'Formulaire de saisie du code par défaut.',
    de: 'Standardformular für die Codeeingabe.',
    ko: '기본 코드 입력 양식입니다.',
    ru: 'Форма ввода кода по умолчанию.',
    id: 'Formulir input kode default.',
  },
  'Default login helper screen.': {
    en: 'Default login helper screen.',
    ja: '標準のログイン補助スクリーンです。',
    'zh-CN': '默认登录辅助表单。',
    'zh-TW': '預設登入輔助表單。',
    es: 'Formulario auxiliar de inicio de sesión predeterminado.',
    pt: 'Formulário auxiliar de login padrão.',
    fr: 'Formulaire d’aide à la connexion par défaut.',
    de: 'Standardformular für die Anmeldehilfe.',
    ko: '기본 로그인 보조 양식입니다.',
    ru: 'Вспомогательная форма входа по умолчанию.',
    id: 'Formulir bantuan masuk default.',
  },
  'Default consent confirmation screen.': {
    en: 'Default consent confirmation screen.',
    ja: '標準の同意確認スクリーンです。',
    'zh-CN': '默认同意确认表单。',
    'zh-TW': '預設同意確認表單。',
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
    'zh-CN': '使用 Passkey 创建账户',
    'zh-TW': '使用 Passkey 建立帳戶',
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
    'zh-CN': '使用 Passkey 登录',
    'zh-TW': '使用 Passkey 登入',
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
    'zh-CN': '电子邮件',
    'zh-TW': '電子郵件',
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
    'zh-CN': '姓名',
    'zh-TW': '姓名',
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
    'zh-CN': '名',
    'zh-TW': '名字',
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
    'zh-CN': '姓',
    'zh-TW': '姓氏',
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
    'zh-CN': '首选用户名',
    'zh-TW': '偏好的使用者名稱',
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
    'zh-CN': '发送验证码',
    'zh-TW': '傳送驗證碼',
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
    'zh-CN': '通过电子邮件发送验证码',
    'zh-TW': '透過電子郵件傳送驗證碼',
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
    'zh-CN': '邮件 OTP + 身份验证器应用',
    'zh-TW': '郵件 OTP + 驗證器應用程式',
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
    'zh-CN': '使用身份验证器应用登录',
    'zh-TW': '使用驗證器應用程式登入',
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
    'zh-CN': '使用身份验证器应用创建账户',
    'zh-TW': '使用驗證器應用程式建立帳戶',
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
    'zh-CN': '验证码',
    'zh-TW': '驗證碼',
    es: 'Código de autenticación',
    pt: 'Código de autenticação',
    fr: 'Code d’authentification',
    de: 'Authentifizierungscode',
    ko: '인증 코드',
    ru: 'Код аутентификации',
    id: 'Kode autentikasi',
  },
  'Enter verification code': {
    en: 'Enter verification code',
    ja: '認証コードを入力',
    'zh-CN': '输入验证码',
    'zh-TW': '輸入驗證碼',
    es: 'Introduce el código de verificación',
    pt: 'Insira o código de verificação',
    fr: 'Saisissez le code de vérification',
    de: 'Bestätigungscode eingeben',
    ko: '인증 코드를 입력하세요',
    ru: 'Введите код подтверждения',
    id: 'Masukkan kode verifikasi',
  },
  'Email verification code': {
    en: 'Email verification code',
    ja: 'メール認証コード',
    'zh-CN': '电子邮件验证码',
    'zh-TW': '電子郵件驗證碼',
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
    'zh-CN': '身份验证器应用代码',
    'zh-TW': '驗證器應用程式代碼',
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
    'zh-CN': '请输入电子邮件或身份验证器应用中的验证码。',
    'zh-TW': '請輸入電子郵件或驗證器應用程式中的驗證碼。',
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
    'zh-CN': '或',
    'zh-TW': '或',
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
    'zh-CN': '使用其他账户继续',
    'zh-TW': '使用其他帳戶繼續',
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
    'zh-CN': '使用外部 IdP 继续',
    'zh-TW': '使用外部 IdP 繼續',
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
    'zh-CN': 'Ext. IdP',
    'zh-TW': 'Ext. IdP',
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
    'zh-CN': '登录',
    'zh-TW': '登入',
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
    'zh-CN': '使用目录密码登录',
    'zh-TW': '使用目錄密碼登入',
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
    'zh-CN': '同意确认',
    'zh-TW': '同意確認',
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
    'zh-CN': '请确认此步骤所需的同意项目。',
    'zh-TW': '請確認此步驟所需的同意項目。',
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
    'zh-CN': '安全验证',
    'zh-TW': '安全驗證',
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
    'zh-CN': '分隔线',
    'zh-TW': '分隔線',
    es: 'Separador',
    pt: 'Divisor',
    fr: 'Séparateur',
    de: 'Trennlinie',
    ko: '구분선',
    ru: 'Разделитель',
    id: 'Pemisah',
  },
  'Account overview': {
    en: 'Account overview',
    ja: 'アカウント概要',
    'zh-CN': '账户概览',
    'zh-TW': '帳戶概覽',
    es: 'Resumen de la cuenta',
    pt: 'Visão geral da conta',
    fr: 'Aperçu du compte',
    de: 'Kontoübersicht',
    ko: '계정 개요',
    ru: 'Обзор учетной записи',
    id: 'Ikhtisar akun',
  },
  'Manage your account': {
    en: 'Manage your account',
    ja: 'アカウントを管理',
    'zh-CN': '管理你的账户',
    'zh-TW': '管理你的帳戶',
    es: 'Gestiona tu cuenta',
    pt: 'Gerencie sua conta',
    fr: 'Gérez votre compte',
    de: 'Konto verwalten',
    ko: '계정 관리',
    ru: 'Управление учетной записью',
    id: 'Kelola akun Anda',
  },
  'Review security settings': {
    en: 'Review security settings',
    ja: 'セキュリティ設定を確認',
    'zh-CN': '查看安全设置',
    'zh-TW': '查看安全設定',
    es: 'Revisar la configuración de seguridad',
    pt: 'Revisar configurações de segurança',
    fr: 'Vérifier les paramètres de sécurité',
    de: 'Sicherheitseinstellungen prüfen',
    ko: '보안 설정 검토',
    ru: 'Проверить настройки безопасности',
    id: 'Tinjau pengaturan keamanan',
  },
  'User profile': {
    en: 'User profile',
    ja: 'ユーザー情報',
    'zh-CN': '用户资料',
    'zh-TW': '使用者資料',
    es: 'Perfil de usuario',
    pt: 'Perfil do usuário',
    fr: 'Profil utilisateur',
    de: 'Benutzerprofil',
    ko: '사용자 프로필',
    ru: 'Профиль пользователя',
    id: 'Profil pengguna',
  },
  Devices: {
    en: 'Devices',
    ja: 'デバイス',
    'zh-CN': '设备',
    'zh-TW': '裝置',
    es: 'Dispositivos',
    pt: 'Dispositivos',
    fr: 'Appareils',
    de: 'Geräte',
    ko: '기기',
    ru: 'Устройства',
    id: 'Perangkat',
  },
  Sessions: {
    en: 'Sessions',
    ja: 'セッション',
    'zh-CN': '会话',
    'zh-TW': '工作階段',
    es: 'Sesiones',
    pt: 'Sessões',
    fr: 'Sessions',
    de: 'Sitzungen',
    ko: '세션',
    ru: 'Сеансы',
    id: 'Sesi',
  },
  Passkeys: {
    en: 'Passkeys',
    ja: 'Passkey',
    'zh-CN': '通行密钥',
    'zh-TW': '通行密鑰',
    es: 'Passkeys',
    pt: 'Passkeys',
    fr: 'Clés d’accès',
    de: 'Passkeys',
    ko: '패스키',
    ru: 'Ключи доступа',
    id: 'Passkey',
  },
  'Authenticator app': {
    en: 'Authenticator app',
    ja: '認証アプリ',
    'zh-CN': '身份验证器应用',
    'zh-TW': '驗證器應用程式',
    es: 'Aplicación de autenticación',
    pt: 'Aplicativo autenticador',
    fr: 'Application d’authentification',
    de: 'Authentifizierungs-App',
    ko: '인증 앱',
    ru: 'Приложение-аутентификатор',
    id: 'Aplikasi autentikator',
  },
  'Consent information': {
    en: 'Consent information',
    ja: '同意情報',
    'zh-CN': '同意信息',
    'zh-TW': '同意資訊',
    es: 'Información de consentimiento',
    pt: 'Informações de consentimento',
    fr: 'Informations de consentement',
    de: 'Einwilligungsinformationen',
    ko: '동의 정보',
    ru: 'Информация о согласиях',
    id: 'Informasi persetujuan',
  },
  'Account activity': {
    en: 'Account activity',
    ja: '操作履歴',
    'zh-CN': '账户活动',
    'zh-TW': '帳戶活動',
    es: 'Actividad de la cuenta',
    pt: 'Atividade da conta',
    fr: 'Activité du compte',
    de: 'Kontoaktivität',
    ko: '계정 활동',
    ru: 'Активность учетной записи',
    id: 'Aktivitas akun',
  },
  'Connected accounts': {
    en: 'Connected accounts',
    ja: '外部アカウント',
    'zh-CN': '已连接的账户',
    'zh-TW': '已連結的帳戶',
    es: 'Cuentas conectadas',
    pt: 'Contas conectadas',
    fr: 'Comptes connectés',
    de: 'Verknüpfte Konten',
    ko: '연결된 계정',
    ru: 'Связанные учетные записи',
    id: 'Akun terhubung',
  },
  'Custom guidance': {
    en: 'Custom guidance',
    ja: 'カスタム案内',
    'zh-CN': '自定义指南',
    'zh-TW': '自訂指南',
    es: 'Orientación personalizada',
    pt: 'Orientação personalizada',
    fr: 'Guide personnalisé',
    de: 'Benutzerdefinierte Hinweise',
    ko: '사용자 지정 안내',
    ru: 'Пользовательские указания',
    id: 'Panduan khusus',
  },
};

const SCREEN_TEXT_LOCALIZATION_ALIASES: Partial<
  Record<keyof typeof SCREEN_TEXT_LOCALIZATIONS, string[]>
> = {
  'Send code by email': ['Send verification code', '認証コードを送信'],
  'Sign in with authenticator app': ['Continue with authenticator app', '認証アプリで続行'],
  'Create account with authenticator app': ['認証アプリでアカウント作成'],
  'Authentication code': ['Code input', 'コード入力'],
  'Ext. IdP': ['Continue with external IdP', 'Sign in with Ext. IdP', 'Ext. IdPでログイン'],
  'Security verification': ['Security check'],
};

function defaultAuthenticationFields(screenKind: 'registration' | 'login'): ScreenField[] {
  const isRegistration = screenKind === 'registration';
  return [
    {
      field: 'auth.passkey',
      label: isRegistration ? 'Create Account with Passkey' : 'Sign in with Passkey',
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
      display_condition: { mode: 'feature_enabled', feature: 'mail_otp' },
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
      label: isRegistration
        ? 'Create account with authenticator app'
        : 'Sign in with authenticator app',
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
      display_condition: { mode: 'feature_enabled', feature: 'external_idp' },
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
      field: 'divider.directory_password',
      label: 'or',
      required: false,
      block_type: 'divider',
      text: 'or',
      display_condition: { mode: 'feature_enabled', feature: 'directory_password' },
      order: 55,
    },
    {
      field: 'auth.directory_password',
      label: 'Sign in with directory password',
      required: false,
      block_type: 'auth_widget',
      auth_method: 'directory_password',
      order: 60,
    },
  ];
}

const DEFAULT_SCREENS: Array<{
  screen_key: string;
  display_name: string;
  description: string;
  screen_kind: ScreenKind;
  fields: ScreenField[];
  settings: ScreenSettings;
}> = [
  {
    screen_key: 'registration',
    display_name: 'Registration',
    description: 'Default registration screen.',
    screen_kind: 'registration',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'heading.registration',
        label: 'Create your account',
        required: false,
        block_type: 'heading',
        order: 0,
      },
      ...defaultAuthenticationFields('registration'),
    ],
  },
  {
    screen_key: 'profile_completion',
    display_name: 'Profile completion',
    description: 'Default profile completion screen.',
    screen_kind: 'profile_completion',
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
    screen_key: 'login',
    display_name: 'Login',
    description: 'Default login screen.',
    screen_kind: 'login',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'heading.login',
        label: 'Sign in',
        required: false,
        block_type: 'heading',
        order: 0,
      },
      ...defaultAuthenticationFields('login'),
    ],
  },
  {
    screen_key: 'code_input',
    display_name: 'Code input',
    description: 'Default code input screen.',
    screen_kind: 'code_input',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'heading.code_input',
        label: 'Enter verification code',
        required: false,
        block_type: 'heading',
        order: 0,
      },
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
    screen_key: 'consent',
    display_name: 'Consent',
    description: 'Default consent confirmation screen.',
    screen_kind: 'consent',
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
  {
    screen_key: 'account_overview',
    display_name: 'Account overview',
    description: 'Account page introduction and safe navigation guidance.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'heading.account_overview',
        label: 'Manage your account',
        required: false,
        block_type: 'heading',
        text: 'Review your profile, sign-in methods, sessions, and consent information.',
        order: 10,
      },
      {
        field: 'link.account_security',
        label: 'Review security settings',
        required: false,
        block_type: 'link',
        href: '#profile',
        order: 20,
      },
    ],
  },
  {
    screen_key: 'account_profile',
    display_name: 'User profile',
    description: 'View and update account profile information.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'account.profile',
        label: 'User profile',
        required: false,
        block_type: 'account_profile_widget',
        order: 10,
      },
    ],
  },
  {
    screen_key: 'account_devices',
    display_name: 'Devices',
    description: 'Show devices associated with the account.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'account.devices',
        label: 'Devices',
        required: false,
        block_type: 'account_device_list_widget',
        order: 10,
      },
    ],
  },
  {
    screen_key: 'account_sessions',
    display_name: 'Sessions',
    description: 'Review and revoke active account sessions.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'account.sessions',
        label: 'Sessions',
        required: false,
        block_type: 'account_session_widget',
        order: 10,
      },
    ],
  },
  {
    screen_key: 'account_passkeys',
    display_name: 'Passkeys',
    description: 'Register and remove account passkeys.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'account.passkeys',
        label: 'Passkeys',
        required: false,
        block_type: 'account_passkey_widget',
        order: 10,
      },
    ],
  },
  {
    screen_key: 'account_totp',
    display_name: 'Authenticator app',
    description: 'Manage authenticator apps and backup codes.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'account.totp',
        label: 'Authenticator app',
        required: false,
        block_type: 'account_totp_widget',
        order: 10,
      },
    ],
  },
  {
    screen_key: 'account_consents',
    display_name: 'Consent information',
    description: 'Review and withdraw document acceptances and release grants.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'account.consents',
        label: 'Consent information',
        required: false,
        block_type: 'account_consent_widget',
        order: 10,
      },
    ],
  },
  {
    screen_key: 'account_activity',
    display_name: 'Account activity',
    description: 'Show recent account-management operations.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'account.activity',
        label: 'Account activity',
        required: false,
        block_type: 'account_activity_widget',
        order: 10,
      },
    ],
  },
  {
    screen_key: 'account_social_accounts',
    display_name: 'Connected accounts',
    description: 'Show connected external accounts when the feature is available.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'account.social_accounts',
        label: 'Connected accounts',
        required: false,
        block_type: 'account_social_account_widget',
        order: 10,
      },
    ],
  },
  {
    screen_key: 'account_custom',
    display_name: 'Custom guidance',
    description: 'Tenant-specific account guidance without account mutations.',
    screen_kind: 'account',
    settings: { canvas_layout: 'wide' },
    fields: [
      {
        field: 'heading.account_custom',
        label: 'Account guidance',
        required: false,
        block_type: 'heading',
        order: 10,
      },
      {
        field: 'text.account_custom',
        label: 'Guidance text',
        required: false,
        block_type: 'text',
        text: 'Add tenant-specific account guidance here.',
        order: 20,
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

function normalizeScreenKey(value: string): string {
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

function readBlockType(value: unknown): ScreenField['block_type'] {
  return typeof value === 'string' && SCREEN_BLOCK_TYPES.has(value)
    ? (value as ScreenField['block_type'])
    : 'identity_field';
}

function readValueType(value: unknown): ScreenField['value_type'] {
  return typeof value === 'string' && SCREEN_VALUE_TYPES.has(value)
    ? (value as ScreenField['value_type'])
    : undefined;
}

function readHumanVerificationTiming(value: unknown): ScreenField['human_verification_timing'] {
  return typeof value === 'string' && SCREEN_HUMAN_VERIFICATION_TIMINGS.has(value)
    ? (value as ScreenField['human_verification_timing'])
    : undefined;
}

function readCodeInputMode(value: unknown): ScreenField['code_input_mode'] {
  return typeof value === 'string' && SCREEN_CODE_INPUT_MODES.has(value)
    ? (value as ScreenField['code_input_mode'])
    : undefined;
}

function readDisplayCondition(value: unknown): ScreenDisplayCondition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Row;
  const mode =
    typeof record.mode === 'string' && SCREEN_DISPLAY_CONDITION_MODES.has(record.mode)
      ? record.mode
      : 'always';
  if (mode === 'hidden') return { mode: 'hidden' };
  if (mode === 'feature_enabled') {
    const feature = readTrimmed(record.feature);
    return {
      mode: 'feature_enabled',
      feature:
        feature && SCREEN_DISPLAY_CONDITION_FEATURES.has(feature)
          ? (feature as ScreenDisplayCondition['feature'])
          : 'passkey',
    };
  }
  return undefined;
}

function readPositiveInteger(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > max) return undefined;
  return value;
}

function normalizeSettings(value: unknown): ScreenSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { canvas_layout: 'narrow' };
  }
  const record = value as Row;
  return {
    canvas_layout: record.canvas_layout === 'wide' ? 'wide' : 'narrow',
    base_preset_key:
      typeof record.base_preset_key === 'string' &&
      /^[a-z0-9_-]{1,96}$/u.test(record.base_preset_key)
        ? record.base_preset_key
        : undefined,
    base_preset_version:
      typeof record.base_preset_version === 'number' &&
      Number.isInteger(record.base_preset_version) &&
      record.base_preset_version > 0
        ? record.base_preset_version
        : undefined,
  };
}

function readSafeLinkHref(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return null;
  const href = value.trim().slice(0, 2048);
  if (!href) return undefined;
  if (href.startsWith('#') && /^#[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(href)) return href;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
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

function normalizeFields(value: unknown): ScreenField[] | null {
  if (!Array.isArray(value)) return null;
  const fields: ScreenField[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Row;
    const field = readTrimmed(record.field);
    const label = readTrimmed(record.label);
    if (!field || !label) return null;
    const blockType = readBlockType(record.block_type);
    const href = readSafeLinkHref(record.href);
    if (blockType === 'link' && !href) return null;
    fields.push({
      field,
      label: label.slice(0, 200),
      required: readBoolean(record.required, false),
      block_type: blockType,
      block_id: readTrimmed(record.block_id) ?? undefined,
      value_type: readValueType(record.value_type),
      auth_method: readTrimmed(record.auth_method),
      code_input_mode: readCodeInputMode(record.code_input_mode),
      external_idp_show_action_text:
        record.external_idp_show_action_text === undefined
          ? undefined
          : readBoolean(record.external_idp_show_action_text, false),
      text: readTrimmed(record.text)?.slice(0, 4000),
      help_text: readTrimmed(record.help_text)?.slice(0, 1000),
      placeholder: readTrimmed(record.placeholder)?.slice(0, 500),
      href,
      human_verification_timing: readHumanVerificationTiming(record.human_verification_timing),
      display_condition: readDisplayCondition(record.display_condition),
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

function validateAccountScreenFields(fields: ScreenField[]): string | null {
  if (fields.some((field) => !ACCOUNT_SCREEN_BLOCK_TYPES.has(field.block_type ?? ''))) {
    return 'Account screens may only contain Account Widgets and supported content blocks';
  }
  const primaryWidgets = fields.filter((field) =>
    ACCOUNT_WIDGET_BLOCK_TYPES.has(field.block_type ?? '')
  );
  if (primaryWidgets.length > 1) {
    return 'Account screens may contain at most one primary Account Widget';
  }
  return null;
}

function normalizeLocalizations(value: unknown): Record<string, ScreenLocalization> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, ScreenLocalization> = {};
  for (const [locale, rawLocalization] of Object.entries(value as Row)) {
    if (!SCREEN_LOCALIZATION_LANGUAGES.includes(locale as ScreenLocalizationLanguage)) continue;
    if (!rawLocalization || typeof rawLocalization !== 'object' || Array.isArray(rawLocalization)) {
      continue;
    }
    const localization = rawLocalization as Row;
    const fields: NonNullable<ScreenLocalization['fields']> = {};
    if (
      localization.fields &&
      typeof localization.fields === 'object' &&
      !Array.isArray(localization.fields)
    ) {
      for (const [key, rawField] of Object.entries(localization.fields as Row).slice(0, 256)) {
        if (!/^[A-Za-z0-9._-]{1,160}$/u.test(key)) continue;
        if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) continue;
        const field = rawField as Row;
        fields[key] = {
          ...(typeof field.label === 'string' ? { label: field.label.trim().slice(0, 200) } : {}),
          ...(typeof field.text === 'string' ? { text: field.text.trim().slice(0, 4000) } : {}),
          ...(typeof field.help_text === 'string'
            ? { help_text: field.help_text.trim().slice(0, 1000) }
            : {}),
          ...(typeof field.placeholder === 'string'
            ? { placeholder: field.placeholder.trim().slice(0, 500) }
            : {}),
        };
      }
    }
    result[locale] = {
      ...(typeof localization.display_name === 'string'
        ? { display_name: localization.display_name.trim().slice(0, 200) }
        : {}),
      ...(typeof localization.description === 'string'
        ? { description: localization.description.trim().slice(0, 1000) }
        : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    };
  }
  return result;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function localizedText(
  value: string | null | undefined,
  language: ScreenLocalizationLanguage
): string {
  if (!value) return '';
  return SCREEN_TEXT_LOCALIZATIONS[value]?.[language] ?? value;
}

function defaultTextValuesForSource(source: string): Set<string> {
  const localizations = SCREEN_TEXT_LOCALIZATIONS[source];
  if (!localizations) return new Set([source]);
  return new Set([
    source,
    ...Object.values(localizations),
    ...(SCREEN_TEXT_LOCALIZATION_ALIASES[source] ?? []),
  ]);
}

function mergeLocalizedDefaultValue(
  current: string | null | undefined,
  source: string | null | undefined,
  language: ScreenLocalizationLanguage
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

function defaultLocalizationKey(field: ScreenField, index: number): string {
  return field.block_id ?? `${field.field}-${index}`;
}

function sameScreenField(left: ScreenField, right: ScreenField): boolean {
  return (
    left.field === right.field &&
    (left.block_type ?? 'identity_field') === (right.block_type ?? 'identity_field')
  );
}

function hasScreenField(fields: ScreenField[], candidate: ScreenField): boolean {
  return fields.some((field) => sameScreenField(field, candidate));
}

function orderedScreenFields(fields: ScreenField[]): ScreenField[] {
  return [...fields].sort(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
  );
}

function defaultScreenField(
  screen: (typeof DEFAULT_SCREENS)[number],
  fieldName: string
): ScreenField | undefined {
  return screen.fields.find((field) => field.field === fieldName);
}

function isRemovedRegistrationDefaultField(field: ScreenField): boolean {
  const blockType = field.block_type ?? 'identity_field';
  return (
    (field.field === 'auth.totp' &&
      blockType === 'auth_widget' &&
      (field.auth_method === undefined || field.auth_method === 'totp')) ||
    (field.field === 'email' && blockType === 'identity_field') ||
    (field.field === 'name' && blockType === 'identity_field')
  );
}

function isLegacyRegistrationDefaultScreen(fields: ScreenField[]): boolean {
  if (fields.length !== 4 || fields.some((field) => field.block_id)) return false;
  const expectedFields = new Map<string, { blockType: string; order: number }>([
    ['auth.passkey', { blockType: 'auth_widget', order: 10 }],
    ['auth.totp', { blockType: 'auth_widget', order: 15 }],
    ['email', { blockType: 'identity_field', order: 20 }],
    ['name', { blockType: 'identity_field', order: 30 }],
  ]);

  return fields.every((field) => {
    const expected = expectedFields.get(field.field);
    return (
      expected !== undefined &&
      (field.block_type ?? 'identity_field') === expected.blockType &&
      field.order === expected.order
    );
  });
}

function isLegacyLoginHelperScreen(fields: ScreenField[]): boolean {
  return (
    fields.length === 1 &&
    fields[0]?.field === 'email' &&
    (fields[0]?.block_type ?? 'identity_field') === 'identity_field'
  );
}

function mergeDefaultScreenLocalizations(
  screen: (typeof DEFAULT_SCREENS)[number],
  fields: ScreenField[],
  current: Record<string, ScreenLocalization>
): Record<string, ScreenLocalization> {
  const next: Record<string, ScreenLocalization> = { ...current };
  for (const language of SCREEN_LOCALIZATION_LANGUAGES) {
    const existing = next[language] ?? {};
    const existingFields = existing.fields ?? {};
    const mergedFields: NonNullable<ScreenLocalization['fields']> = { ...existingFields };

    for (const [index, field] of fields.entries()) {
      const defaultField =
        screen.fields.find((candidate) => sameScreenField(candidate, field)) ??
        screen.fields[index];
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
        screen.display_name,
        language
      ),
      description: mergeLocalizedDefaultValue(existing.description, screen.description, language),
      fields: mergedFields,
    };
  }
  return next;
}

function mergeDefaultScreenFieldMetadata(
  screen: (typeof DEFAULT_SCREENS)[number],
  fields: ScreenField[]
): ScreenField[] {
  let changed = false;
  let working = fields;

  if (screen.screen_key === 'registration') {
    if (isLegacyRegistrationDefaultScreen(fields)) {
      working = fields.filter((field) => !isRemovedRegistrationDefaultField(field));
      if (working.length !== fields.length) changed = true;
    }
    for (const fieldName of [
      'heading.registration',
      'auth.passkey',
      'divider.or',
      'auth.mail_otp',
      'auth.totp',
      'divider.other_accounts',
      'auth.external_idp',
      'divider.directory_password',
      'auth.directory_password',
    ]) {
      const defaultField = defaultScreenField(screen, fieldName);
      if (defaultField && !hasScreenField(working, defaultField)) {
        working = [...working, defaultField];
        changed = true;
      }
    }
  } else if (screen.screen_key === 'login' && isLegacyLoginHelperScreen(fields)) {
    working = screen.fields;
    changed = true;
  } else if (screen.screen_key === 'login') {
    const headingField = defaultScreenField(screen, 'heading.login');
    if (headingField && !hasScreenField(working, headingField)) {
      working = [...working, headingField];
      changed = true;
    }
    const directoryField = defaultScreenField(screen, 'auth.directory_password');
    const directoryDividerField = defaultScreenField(screen, 'divider.directory_password');
    if (
      directoryField &&
      directoryDividerField &&
      hasScreenField(working, directoryField) &&
      !hasScreenField(working, directoryDividerField)
    ) {
      working = [...working, directoryDividerField];
      changed = true;
    }
  } else if (screen.screen_key === 'code_input') {
    for (const fieldName of ['heading.code_input', 'auth.code_input']) {
      const defaultField = defaultScreenField(screen, fieldName);
      if (defaultField && !hasScreenField(working, defaultField)) {
        working = [...working, defaultField];
        changed = true;
      }
    }
  }

  const next = orderedScreenFields(working).map((field) => {
    const defaultField = screen.fields.find((candidate) => sameScreenField(candidate, field));
    if (!defaultField?.display_condition || field.display_condition) return field;
    changed = true;
    return {
      ...field,
      display_condition: defaultField.display_condition,
    };
  });
  return changed ? next : fields;
}

function toResponse(row: Row): ScreenResponse {
  const parsedFields = parseJson<ScreenField[]>(row.fields_json, []);
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    screen_key: String(row.screen_key),
    display_name: String(row.display_name),
    description: typeof row.description === 'string' ? row.description : null,
    screen_kind: String(row.screen_kind) as ScreenKind,
    fields: normalizeFields(parsedFields) ?? [],
    localizations: normalizeLocalizations(
      parseJson<Record<string, ScreenLocalization>>(row.localizations_json, {})
    ),
    settings: normalizeSettings(parseJson<ScreenSettings | null>(row.settings_json, null)),
    is_active: row.is_active as number | boolean,
    is_system: row.is_system as number | boolean,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export async function ensureDefaultScreens(c: AdminContext, tenantId: string): Promise<void> {
  const authCtx = createAuthContextFromHono(c, tenantId);
  for (const screen of DEFAULT_SCREENS) {
    const existing = await authCtx.coreAdapter.queryOne<Row>(
      `SELECT id, screen_kind, fields_json, localizations_json, is_system
         FROM screens
        WHERE tenant_id = ? AND screen_key = ?`,
      [tenantId, screen.screen_key]
    );
    if (existing) {
      if (readBoolean(existing.is_system, false)) {
        const fields = parseJson<ScreenField[]>(existing.fields_json, screen.fields);
        const mergedFields = mergeDefaultScreenFieldMetadata(screen, fields);
        const currentLocalizations = normalizeLocalizations(
          parseJson<Record<string, ScreenLocalization>>(existing.localizations_json, {})
        );
        const mergedLocalizations = mergeDefaultScreenLocalizations(
          screen,
          mergedFields.length > 0 ? mergedFields : screen.fields,
          currentLocalizations
        );
        if (serializeJson(mergedFields) !== serializeJson(fields)) {
          await authCtx.coreAdapter.execute(
            `UPDATE screens
                SET fields_json = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
            [serializeJson(mergedFields), nowMs(), tenantId, existing.id]
          );
        }
        if (serializeJson(mergedLocalizations) !== serializeJson(currentLocalizations)) {
          await authCtx.coreAdapter.execute(
            `UPDATE screens
                SET localizations_json = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
            [serializeJson(mergedLocalizations), nowMs(), tenantId, existing.id]
          );
        }
        if (existing.screen_kind !== screen.screen_kind) {
          await authCtx.coreAdapter.execute(
            `UPDATE screens
                SET screen_kind = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
            [screen.screen_kind, nowMs(), tenantId, existing.id]
          );
        }
      }
      continue;
    }
    await authCtx.coreAdapter.execute(
      `INSERT INTO screens
       (id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
        localizations_json, settings_json, is_active, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        screen.screen_key,
        screen.display_name,
        screen.description,
        screen.screen_kind,
        serializeJson(screen.fields),
        serializeJson(mergeDefaultScreenLocalizations(screen, screen.fields, {})),
        serializeJson(screen.settings),
        1,
        1,
        nowMs(),
        nowMs(),
      ]
    );
  }
}

export async function getActiveAccountScreens(
  c: AdminContext,
  tenantId: string
): Promise<ScreenResponse[]> {
  await ensureDefaultScreens(c, tenantId);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const rows = await authCtx.coreAdapter.query(
    `SELECT * FROM screens
     WHERE tenant_id = ? AND screen_kind = 'account' AND is_active = 1
     ORDER BY display_name ASC`,
    [tenantId]
  );
  return (rows as Row[]).map(toResponse);
}

export async function adminScreensListHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_SCREENS');
  try {
    const tenantId = getTenantIdFromContext(c);
    await ensureDefaultScreens(c, tenantId);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM screens
       WHERE tenant_id = ?
       ORDER BY is_system DESC, screen_kind ASC, display_name ASC`,
      [tenantId]
    );
    return c.json({ screens: (rows as Row[]).map(toResponse) });
  } catch (error) {
    log.error('Failed to list screens', { action: 'list' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list screens' }, 500);
  }
}

export async function adminScreenGetHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_SCREENS');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM screens WHERE tenant_id = ? AND id = ?',
      [tenantId, c.req.param('id')]
    );
    if (!row) return notFound(c, 'Screen not found');
    return c.json({ screen: toResponse(row) });
  } catch (error) {
    log.error('Failed to get screen', { action: 'get' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to get screen' }, 500);
  }
}

export async function adminScreenCreateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_SCREENS');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const body = await c.req.json<Row>();
    const displayName = readTrimmed(body.display_name);
    const rawKey = readTrimmed(body.screen_key) ?? displayName;
    const screenKey = rawKey ? normalizeScreenKey(rawKey) : '';
    const screenKind = body.screen_kind;
    const fields = normalizeFields(body.fields);
    if (!displayName) return invalid(c, 'display_name is required');
    if (!screenKey) return invalid(c, 'screen_key is required');
    if (!SCREEN_KINDS.has(screenKind as ScreenKind)) return invalid(c, 'Invalid screen_kind');
    if (!fields || fields.length === 0) return invalid(c, 'fields must contain at least one field');
    if (screenKind === 'account') {
      const accountValidationError = validateAccountScreenFields(fields);
      if (accountValidationError) return invalid(c, accountValidationError);
    }

    const now = nowMs();
    const id = crypto.randomUUID();
    await authCtx.coreAdapter.execute(
      `INSERT INTO screens
       (id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
        localizations_json, settings_json, is_active, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        screenKey,
        displayName,
        readTrimmed(body.description),
        screenKind,
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
      'SELECT * FROM screens WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    await recordScreenAudit(c, 'screen.created', id, {
      screen_key: screenKey,
      screen_kind: screenKind,
      base_preset_key: normalizeSettings(body.settings).base_preset_key ?? null,
    });
    return c.json({ screen: row ? toResponse(row) : null }, 201);
  } catch (error) {
    log.error('Failed to create screen', { action: 'create' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to create screen' }, 500);
  }
}

export async function adminScreenUpdateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_SCREENS');
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');
    if (!id) return invalid(c, 'Screen id is required');
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existing = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT id, is_system, screen_kind, fields_json FROM screens WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    if (!existing) return notFound(c, 'Screen not found');
    if (readBoolean(existing.is_system, false)) {
      return invalid(c, 'System screens are immutable; create a custom copy before editing');
    }
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
    if (body.screen_kind !== undefined) {
      if (!SCREEN_KINDS.has(body.screen_kind as ScreenKind))
        return invalid(c, 'Invalid screen_kind');
      sets.push('screen_kind = ?');
      params.push(body.screen_kind);
    }
    if (body.fields !== undefined) {
      const fields = normalizeFields(body.fields);
      if (!fields || fields.length === 0) {
        return invalid(c, 'fields must contain at least one field');
      }
      const effectiveKind = (body.screen_kind ?? existing.screen_kind) as ScreenKind;
      if (effectiveKind === 'account') {
        const accountValidationError = validateAccountScreenFields(fields);
        if (accountValidationError) return invalid(c, accountValidationError);
      }
      sets.push('fields_json = ?');
      params.push(serializeJson(fields));
    } else if (body.screen_kind === 'account') {
      const existingFields = parseJson<ScreenField[]>(existing.fields_json, []);
      const accountValidationError = validateAccountScreenFields(existingFields);
      if (accountValidationError) return invalid(c, accountValidationError);
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
      `UPDATE screens SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
      params
    );
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM screens WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    await recordScreenAudit(c, 'screen.updated', id, {
      changed_fields: Object.keys(body).sort(),
      base_preset_key: normalizeSettings(body.settings).base_preset_key ?? null,
    });
    return c.json({ screen: row ? toResponse(row) : null });
  } catch (error) {
    log.error('Failed to update screen', { action: 'update' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update screen' }, 500);
  }
}

export async function adminScreenDeleteHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_SCREENS');
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');
    if (!id) return invalid(c, 'Screen id is required');
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existing = await authCtx.coreAdapter.queryOne<{ is_system: number | boolean }>(
      'SELECT is_system FROM screens WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    if (!existing) return notFound(c, 'Screen not found');
    if (readBoolean(existing.is_system, false))
      return invalid(c, 'System screens cannot be deleted');
    await authCtx.coreAdapter.execute('DELETE FROM screens WHERE tenant_id = ? AND id = ?', [
      tenantId,
      id,
    ]);
    await recordScreenAudit(c, 'screen.deleted', id, {});
    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete screen', { action: 'delete' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete screen' }, 500);
  }
}
