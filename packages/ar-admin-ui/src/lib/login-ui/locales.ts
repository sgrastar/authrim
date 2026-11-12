import {
	LOGIN_UI_LANGUAGE_METADATA,
	LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD,
	MAX_LOGIN_UI_PRIMARY_LOCALES,
	parseConfiguredPrimaryLoginUILocales,
	selectDefaultPrimaryLoginUILocales,
	sortLoginUILocalesByEnglishName,
	type LoginUILocale
} from '@authrim/ar-lib-core/types/login-ui-languages';

export {
	LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD,
	MAX_LOGIN_UI_PRIMARY_LOCALES,
	parseConfiguredPrimaryLoginUILocales,
	selectDefaultPrimaryLoginUILocales,
	type LoginUILocale
};

export const LOGIN_UI_LOCALE_OPTIONS = LOGIN_UI_LANGUAGE_METADATA.map((metadata) => ({
	code: metadata.localeCode,
	label: metadata.englishName,
	metadata
})).sort((left, right) => left.label.localeCompare(right.label, 'en', { sensitivity: 'base' }));

export const ALL_LOGIN_UI_LOCALES = sortLoginUILocalesByEnglishName(
	LOGIN_UI_LANGUAGE_METADATA.map(({ localeCode }) => localeCode)
);

export const DEFAULT_LOGIN_UI_TAGLINES: Record<LoginUILocale, string> = {
	en: 'Your account, kept safe.',
	ja: 'あなたのアカウントを、安全に。',
	'zh-CN': '安全守护您的账户。',
	'zh-TW': '安全守護您的帳戶。',
	es: 'Tu cuenta, siempre segura.',
	pt: 'Sua conta, sempre segura.',
	fr: 'Votre compte, en toute sécurité.',
	de: 'Ihr Konto, sicher geschützt.',
	ko: '당신의 계정을 안전하게.',
	ru: 'Ваша учётная запись под надёжной защитой.',
	id: 'Akun Anda, tetap aman.',
	ar: 'حسابك، في أمان.',
	it: 'Il tuo account, al sicuro.',
	th: 'บัญชีของคุณ ปลอดภัยเสมอ',
	vi: 'Tài khoản của bạn, luôn an toàn.',
	hi: 'आपका खाता, सुरक्षित।',
	bn: 'আপনার অ্যাকাউন্ট, সুরক্ষিত।',
	tr: 'Hesabınız güvende.',
	sw: 'Akaunti yako, salama.',
	am: 'መለያዎ፣ ደህንነቱ የተጠበቀ።',
	pl: 'Twoje konto, bezpieczne.'
};

const AUTHRIM_FOOTER_LINK = '<a href="https://authrim.com/">Authrim</a>';

export const DEFAULT_LOGIN_UI_FOOTER_TEXTS: Record<LoginUILocale, string> = {
	en: `Powered by ${AUTHRIM_FOOTER_LINK}`,
	ja: `Powered by ${AUTHRIM_FOOTER_LINK}`,
	'zh-CN': `由 ${AUTHRIM_FOOTER_LINK} 提供支持`,
	'zh-TW': `由 ${AUTHRIM_FOOTER_LINK} 提供技術支援`,
	es: `Con tecnología de ${AUTHRIM_FOOTER_LINK}`,
	pt: `Desenvolvido com tecnologia ${AUTHRIM_FOOTER_LINK}`,
	fr: `Propulsé par ${AUTHRIM_FOOTER_LINK}`,
	de: `Bereitgestellt von ${AUTHRIM_FOOTER_LINK}`,
	ko: `Powered by ${AUTHRIM_FOOTER_LINK}`,
	ru: `Работает на ${AUTHRIM_FOOTER_LINK}`,
	id: `Didukung oleh ${AUTHRIM_FOOTER_LINK}`,
	ar: `مدعوم من ${AUTHRIM_FOOTER_LINK}`,
	it: `Basato su ${AUTHRIM_FOOTER_LINK}`,
	th: `ขับเคลื่อนโดย ${AUTHRIM_FOOTER_LINK}`,
	vi: `Được cung cấp bởi ${AUTHRIM_FOOTER_LINK}`,
	hi: `${AUTHRIM_FOOTER_LINK} द्वारा संचालित`,
	bn: `${AUTHRIM_FOOTER_LINK} দ্বারা পরিচালিত`,
	tr: `${AUTHRIM_FOOTER_LINK} tarafından desteklenmektedir`,
	sw: `Inaendeshwa na ${AUTHRIM_FOOTER_LINK}`,
	am: `በ${AUTHRIM_FOOTER_LINK} የተጎላበተ`,
	pl: `Obsługiwane przez ${AUTHRIM_FOOTER_LINK}`
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
	},
	hi: {
		loginTitle: 'वापसी पर स्वागत है',
		registrationTitle: 'अपना खाता बनाएँ',
		accountTitle: 'खाता'
	},
	bn: {
		loginTitle: 'আবার স্বাগতম',
		registrationTitle: 'আপনার অ্যাকাউন্ট তৈরি করুন',
		accountTitle: 'অ্যাকাউন্ট'
	},
	tr: {
		loginTitle: 'Tekrar hoş geldiniz',
		registrationTitle: 'Hesabınızı oluşturun',
		accountTitle: 'Hesap'
	},
	sw: {
		loginTitle: 'Karibu tena',
		registrationTitle: 'Fungua akaunti yako',
		accountTitle: 'Akaunti'
	},
	am: { loginTitle: 'እንኳን ደህና መጡ', registrationTitle: 'መለያዎን ይፍጠሩ', accountTitle: 'መለያ' },
	pl: { loginTitle: 'Witamy ponownie', registrationTitle: 'Utwórz konto', accountTitle: 'Konto' }
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

export function resolveEnabledLoginUILocalesByEnglishName(value: unknown): LoginUILocale[] {
	return sortLoginUILocalesByEnglishName(resolveEnabledLoginUILocales(value));
}

export function resolveDefaultLoginUILocale(
	value: unknown,
	enabledLocales: readonly LoginUILocale[]
): LoginUILocale {
	return isLoginUILocale(value) && enabledLocales.includes(value)
		? value
		: enabledLocales.includes('en')
			? 'en'
			: (enabledLocales[0] ?? 'en');
}
