export const LOGIN_UI_LOCALE_OPTIONS = [
	{ code: 'en', label: 'English' },
	{ code: 'ja', label: 'Japanese' },
	{ code: 'zh-CN', label: 'Chinese (Simplified)' },
	{ code: 'zh-TW', label: 'Chinese (Traditional)' },
	{ code: 'es', label: 'Spanish' },
	{ code: 'pt', label: 'Portuguese' },
	{ code: 'fr', label: 'French' },
	{ code: 'de', label: 'German' },
	{ code: 'ko', label: 'Korean' },
	{ code: 'ru', label: 'Russian' },
	{ code: 'id', label: 'Indonesian' },
	{ code: 'ar', label: 'Arabic' },
	{ code: 'it', label: 'Italian' },
	{ code: 'th', label: 'Thai' },
	{ code: 'vi', label: 'Vietnamese' }
] as const;

export type LoginUILocale = (typeof LOGIN_UI_LOCALE_OPTIONS)[number]['code'];

export const ALL_LOGIN_UI_LOCALES = LOGIN_UI_LOCALE_OPTIONS.map((locale) => locale.code);

export const DEFAULT_LOGIN_UI_TAGLINES: Record<LoginUILocale, string> = {
	en: 'Identity & Access at the edge of everywhere.',
	ja: 'アイデンティティ＆アクセスをあらゆる場所で',
	'zh-CN': '身份与访问，无处不在',
	'zh-TW': '身分與存取，無所不在',
	es: 'Identidad y acceso en todas partes.',
	pt: 'Identidade e acesso em todos os lugares.',
	fr: 'Identité et accès partout.',
	de: 'Identität und Zugriff überall.',
	ko: '어디서나 가능한 아이덴티티 및 액세스',
	ru: 'Идентификация и доступ повсюду.',
	id: 'Identitas dan akses di mana saja.',
	ar: 'الهوية والوصول في كل مكان.',
	it: 'Identità e accesso ovunque.',
	th: 'อัตลักษณ์และการเข้าถึงได้จากทุกที่',
	vi: 'Danh tính và quyền truy cập ở mọi nơi.'
};

const AUTHRIM_FOOTER_LINK = '<a href="https://authrim.com/">Authrim</a>';

export const DEFAULT_LOGIN_UI_FOOTER_TEXTS: Record<LoginUILocale, string> = {
	en: `Powered by ${AUTHRIM_FOOTER_LINK}`,
	ja: `${AUTHRIM_FOOTER_LINK} が提供しています`,
	'zh-CN': `由 ${AUTHRIM_FOOTER_LINK} 提供支持`,
	'zh-TW': `由 ${AUTHRIM_FOOTER_LINK} 提供技術支援`,
	es: `Con tecnología de ${AUTHRIM_FOOTER_LINK}`,
	pt: `Desenvolvido com tecnologia ${AUTHRIM_FOOTER_LINK}`,
	fr: `Propulsé par ${AUTHRIM_FOOTER_LINK}`,
	de: `Bereitgestellt von ${AUTHRIM_FOOTER_LINK}`,
	ko: `${AUTHRIM_FOOTER_LINK} 제공`,
	ru: `Работает на ${AUTHRIM_FOOTER_LINK}`,
	id: `Didukung oleh ${AUTHRIM_FOOTER_LINK}`,
	ar: `مدعوم من ${AUTHRIM_FOOTER_LINK}`,
	it: `Basato su ${AUTHRIM_FOOTER_LINK}`,
	th: `ขับเคลื่อนโดย ${AUTHRIM_FOOTER_LINK}`,
	vi: `Được cung cấp bởi ${AUTHRIM_FOOTER_LINK}`
};

export type LoginUIPageTitleDefaults = {
	loginTitle: string;
	registrationTitle: string;
	accountTitle: string;
};

export const DEFAULT_LOGIN_UI_PAGE_TITLES: Record<LoginUILocale, LoginUIPageTitleDefaults> = {
	en: {
		loginTitle: 'Welcome back',
		registrationTitle: 'Create your account',
		accountTitle: 'Account'
	},
	ja: {
		loginTitle: 'おかえりなさい',
		registrationTitle: 'アカウント作成',
		accountTitle: 'アカウント'
	},
	'zh-CN': { loginTitle: '欢迎回来', registrationTitle: '创建账户', accountTitle: '账户' },
	'zh-TW': { loginTitle: '歡迎回來', registrationTitle: '建立帳戶', accountTitle: '帳戶' },
	es: {
		loginTitle: 'Te damos la bienvenida',
		registrationTitle: 'Crea tu cuenta',
		accountTitle: 'Cuenta'
	},
	pt: { loginTitle: 'Boas-vindas', registrationTitle: 'Crie sua conta', accountTitle: 'Conta' },
	fr: {
		loginTitle: 'Ravi de vous revoir',
		registrationTitle: 'Créez votre compte',
		accountTitle: 'Compte'
	},
	de: {
		loginTitle: 'Willkommen zurück',
		registrationTitle: 'Konto erstellen',
		accountTitle: 'Konto'
	},
	ko: {
		loginTitle: '다시 오신 것을 환영합니다',
		registrationTitle: '계정 만들기',
		accountTitle: '계정'
	},
	ru: {
		loginTitle: 'С возвращением',
		registrationTitle: 'Создайте учётную запись',
		accountTitle: 'Учётная запись'
	},
	id: {
		loginTitle: 'Selamat datang kembali',
		registrationTitle: 'Buat akun Anda',
		accountTitle: 'Akun'
	},
	ar: { loginTitle: 'مرحبًا بعودتك', registrationTitle: 'إنشاء حسابك', accountTitle: 'الحساب' },
	it: {
		loginTitle: 'Bentornato',
		registrationTitle: 'Crea il tuo account',
		accountTitle: 'Account'
	},
	th: {
		loginTitle: 'ยินดีต้อนรับกลับ',
		registrationTitle: 'สร้างบัญชีของคุณ',
		accountTitle: 'บัญชี'
	},
	vi: {
		loginTitle: 'Chào mừng bạn trở lại',
		registrationTitle: 'Tạo tài khoản',
		accountTitle: 'Tài khoản'
	}
};

const LEGACY_DEFAULT_LOGIN_UI_LOCALES: LoginUILocale[] = [
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
	'id'
];

export function isLoginUILocale(value: unknown): value is LoginUILocale {
	return typeof value === 'string' && ALL_LOGIN_UI_LOCALES.includes(value as LoginUILocale);
}

export function resolveEnabledLoginUILocales(value: unknown): LoginUILocale[] {
	const parsed =
		typeof value === 'string'
			? value
					.split(',')
					.map((locale) => locale.trim())
					.filter(isLoginUILocale)
			: [];
	const unique = [...new Set(parsed)];
	const isLegacyDefault =
		unique.length === LEGACY_DEFAULT_LOGIN_UI_LOCALES.length &&
		LEGACY_DEFAULT_LOGIN_UI_LOCALES.every((locale) => unique.includes(locale));
	return unique.length === 0 || isLegacyDefault ? [...ALL_LOGIN_UI_LOCALES] : unique;
}
