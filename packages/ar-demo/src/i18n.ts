/** Languages, the typed message table and language selection. No HTML in here. */

/** The languages of the admin console (ar-admin-console/src/lib/i18n/locales.ts), in its order. */
export const LANGS = ['ja', 'en', 'de', 'ar'] as const;
export type Lang = (typeof LANGS)[number];

export type ErrorKind =
  | 'forbidden'
  | 'bad_request'
  | 'verification'
  | 'ip_limit'
  | 'capacity'
  | 'failed'
  | 'config'
  | 'not_found'
  | 'method';

/** Texts the gate script needs; they travel to the page as data attributes. */
export interface GateTexts {
  gateTitle: string;
  gateTitleReady: string;
  /** In-progress lines: written without a final full stop, the page adds animated dots. */
  gateChecking: string;
  gateAccepted: string;
  gateInviting: string;
  gateSlow: string;
  gateUnstable: string;
  gateOpening: string;
  gateArriving: string;
  gateReady: string;
  gateLastMinute: string;
  gateExpired: string;
  timeout: string;
  failed: string;
  handedOff: string;
  lost: string;
}

export interface Copy extends GateTexts {
  /** The language's own name, shown in the switcher. */
  name: string;
  /** Value of the `lang` attribute. */
  htmlLang: string;
  dir: 'ltr' | 'rtl';
  /** Value of the Turnstile `data-language` attribute. */
  turnstile: string;
  /** Accessible name of the language switcher. */
  languageLabel: string;
  title: string;
  intro1: string;
  intro2: string;
  noticeTitle: string;
  notices: (hours: number) => [string, string, string];
  start: string;
  skipLabel: string;
  sealLabel: string;
  retry: string;
  noscript: string;
  errorTitle: string;
  errors: Record<ErrorKind, string>;
  back: string;
}

/** Arabic count words: 1, 2, 3-10 and the rest take different forms. */
function arabicHours(hours: number): string {
  if (hours === 1) return 'ساعة واحدة';
  if (hours === 2) return 'ساعتين';
  return hours >= 3 && hours <= 10 ? `${hours} ساعات` : `${hours} ساعة`;
}

export const COPY: Record<Lang, Copy> = {
  ja: {
    name: '日本語',
    htmlLang: 'ja',
    dir: 'ltr',
    turnstile: 'ja',
    languageLabel: '言語',
    title: 'Authrim デモ環境',
    intro1:
      'Authrim のエンドユーザー向けログインと管理者向けの画面を、実際に操作して試せるデモ環境です。',
    intro2:
      '「開始する」を押すと、あなた専用のテナントが作成され、設定を自由に変更できます（一部、変更できない項目があります）。',
    noticeTitle: '注意',
    notices: (hours) => [
      'これは動作確認のためのデモ環境です。',
      '実際の個人情報や本物の認証情報は入力しないでください。',
      `作成したものはすべて、約${hours}時間後に自動で削除されます。`,
    ],
    start: '開始する',
    gateTitle: 'デモ環境を準備しています',
    gateTitleReady: 'デモ環境の準備ができました',
    gateChecking: '受付を確認しています',
    gateAccepted: '環境を作成しています',
    gateInviting: '管理者の招待を準備しています',
    gateSlow: '時間がかかっています。このままお待ちください',
    gateUnstable: '通信が不安定です。確認を続けています',
    gateOpening: '管理コンソールへ移動します',
    gateArriving: '準備ができました。まもなくボタンが表示されます。',
    gateReady: '準備ができました。下のボタンで管理コンソールを開きます。',
    skipLabel: '演出を省略',
    sealLabel: '管理コンソールを開く',
    gateLastMinute:
      'このリンクはあと約1分で使えなくなります。今すぐ管理コンソールを開いてください。',
    gateExpired: '管理コンソールを開く時間が過ぎました。最初からやり直してください。',
    timeout: '時間がかかりすぎています。最初からやり直してください。',
    failed: 'デモ環境を作成できませんでした。もう一度お試しください。',
    handedOff: 'この環境はすでに開かれています。ページを閉じた場合は、最初からやり直してください。',
    lost: 'このセッションが見つかりません。最初からやり直してください。',
    retry: '最初からやり直す',
    noscript:
      'このページでは、準備の進み具合を確認して管理コンソールを開くために JavaScript が必要です。',
    errorTitle: '続行できません',
    errors: {
      forbidden:
        'リクエストは受け付けられませんでした。開始ページを開き、そこからもう一度お試しください。',
      bad_request: 'リクエストを読み取れませんでした。開始ページに戻って、もう一度お試しください。',
      verification: '確認に失敗しました。前の画面に戻って、もう一度お試しください。',
      ip_limit: '1日に作成できるデモ環境の上限に達しました。明日もう一度お試しください。',
      capacity: '現在、デモ環境は満員です。しばらくしてからもう一度お試しください。',
      failed: 'デモ環境を作成できませんでした。しばらくしてからもう一度お試しください。',
      config: '現在、デモ環境をご利用いただけません。しばらくしてからもう一度お試しください。',
      not_found: 'ページが見つかりません。開始ページに戻ってください。',
      method: 'ここではこのメソッドは使えません。開始ページに戻ってください。',
    },
    back: '開始ページへ戻る',
  },
  en: {
    name: 'English',
    htmlLang: 'en',
    dir: 'ltr',
    turnstile: 'en',
    languageLabel: 'Language',
    title: 'Authrim Demo',
    intro1:
      'A demo environment where you can try Authrim’s end-user sign-in and administrator screens hands-on.',
    intro2:
      'Press “Start” to create a tenant of your own, where you can change settings freely (a few items cannot be changed).',
    noticeTitle: 'Please note',
    notices: (hours) => [
      'This is a demo environment for testing only.',
      'Do not enter real personal data or real credentials.',
      `Everything you create is deleted automatically after about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
    ],
    start: 'Start',
    gateTitle: 'Preparing your demo environment',
    gateTitleReady: 'Your demo environment is ready',
    gateChecking: 'Checking your request',
    gateAccepted: 'Creating the environment',
    gateInviting: 'Preparing the administrator invitation',
    gateSlow: 'This is taking longer than usual. Please keep this page open',
    gateUnstable: 'The connection seems unstable. Still checking',
    gateOpening: 'Taking you to the admin console',
    gateArriving: 'Your environment is ready. The button will appear in a moment.',
    gateReady: 'Your environment is ready. Use the button below to open the admin console.',
    skipLabel: 'Skip the animation',
    sealLabel: 'Open the admin console',
    gateLastMinute: 'This link stays valid for about one more minute. Open the admin console now.',
    gateExpired: 'The time to open the admin console has passed. Please start again.',
    timeout: 'This is taking longer than expected. Please start again.',
    failed: 'The demo environment could not be created. Please try again.',
    handedOff:
      'This environment has already been opened. If you closed that page, please start again.',
    lost: 'This session was not found. Please start again.',
    retry: 'Start again',
    noscript:
      'This page needs JavaScript to follow the preparation and open the admin console for you.',
    errorTitle: 'Could not continue',
    errors: {
      forbidden: 'The request was not accepted. Open the start page and try again from there.',
      bad_request: 'The request could not be read. Go back to the start page and try again.',
      verification: 'The verification failed. Go back and try again.',
      ip_limit: 'You have reached the daily limit of demo environments. Please try again tomorrow.',
      capacity: 'The demo is full right now. Please try again later.',
      failed: 'The demo environment could not be created. Please try again later.',
      config: 'The demo is not available right now. Please try again later.',
      not_found: 'This page does not exist. Go back to the start page.',
      method: 'This method is not allowed here. Go back to the start page.',
    },
    back: 'Back to the start page',
  },
  de: {
    name: 'Deutsch',
    htmlLang: 'de',
    dir: 'ltr',
    turnstile: 'de',
    languageLabel: 'Sprache',
    title: 'Authrim Demo',
    intro1:
      'Eine Demo-Umgebung, in der du die Anmeldung für Endnutzer und die Verwaltungsoberfläche von Authrim direkt ausprobieren kannst.',
    intro2:
      'Mit „Starten“ wird ein eigener Tenant für dich angelegt, dessen Einstellungen du frei ändern kannst (einige wenige Punkte sind nicht änderbar).',
    noticeTitle: 'Bitte beachten',
    notices: (hours) => [
      'Dies ist eine Demo-Umgebung nur zum Ausprobieren.',
      'Gib keine echten personenbezogenen Daten und keine echten Zugangsdaten ein.',
      `Alles, was du anlegst, wird nach etwa ${hours} ${hours === 1 ? 'Stunde' : 'Stunden'} automatisch gelöscht.`,
    ],
    start: 'Starten',
    gateTitle: 'Deine Demo-Umgebung wird vorbereitet',
    gateTitleReady: 'Deine Demo-Umgebung ist bereit',
    gateChecking: 'Deine Anfrage wird geprüft',
    gateAccepted: 'Die Umgebung wird erstellt',
    gateInviting: 'Die Administrator-Einladung wird vorbereitet',
    gateSlow: 'Das dauert länger als gewöhnlich. Bitte lass diese Seite geöffnet',
    gateUnstable: 'Die Verbindung scheint instabil zu sein. Wir prüfen weiter',
    gateOpening: 'Du wirst zur Admin-Konsole weitergeleitet',
    gateArriving: 'Deine Umgebung ist bereit. Die Schaltfläche erscheint gleich.',
    gateReady: 'Deine Umgebung ist bereit. Öffne die Admin-Konsole mit der Schaltfläche unten.',
    skipLabel: 'Animation überspringen',
    sealLabel: 'Admin-Konsole öffnen',
    gateLastMinute:
      'Dieser Link ist nur noch etwa eine Minute gültig. Öffne jetzt die Admin-Konsole.',
    gateExpired: 'Die Zeit zum Öffnen der Admin-Konsole ist abgelaufen. Bitte starte neu.',
    timeout: 'Das dauert länger als erwartet. Bitte starte neu.',
    failed: 'Die Demo-Umgebung konnte nicht erstellt werden. Bitte versuche es erneut.',
    handedOff:
      'Diese Umgebung wurde bereits geöffnet. Falls du die Seite geschlossen hast, starte neu.',
    lost: 'Diese Sitzung wurde nicht gefunden. Bitte starte neu.',
    retry: 'Neu starten',
    noscript:
      'Diese Seite braucht JavaScript, um die Vorbereitung zu verfolgen und die Admin-Konsole für dich zu öffnen.',
    errorTitle: 'Das hat nicht geklappt',
    errors: {
      forbidden:
        'Die Anfrage wurde nicht angenommen. Öffne die Startseite und versuche es von dort erneut.',
      bad_request:
        'Die Anfrage konnte nicht gelesen werden. Gehe zurück zur Startseite und versuche es noch einmal.',
      verification: 'Die Überprüfung ist fehlgeschlagen. Gehe zurück und versuche es noch einmal.',
      ip_limit: 'Du hast das Tageslimit für Demo-Umgebungen erreicht. Versuche es morgen wieder.',
      capacity: 'Die Demo ist gerade voll. Versuche es später noch einmal.',
      failed: 'Die Demo-Umgebung konnte nicht erstellt werden. Versuche es später noch einmal.',
      config: 'Die Demo ist derzeit nicht verfügbar. Versuche es später noch einmal.',
      not_found: 'Diese Seite gibt es nicht. Gehe zurück zur Startseite.',
      method: 'Diese Methode ist hier nicht erlaubt. Gehe zurück zur Startseite.',
    },
    back: 'Zur Startseite',
  },
  ar: {
    name: 'العربية',
    htmlLang: 'ar',
    dir: 'rtl',
    turnstile: 'ar',
    languageLabel: 'اللغة',
    title: 'بيئة Authrim التجريبية',
    intro1:
      'بيئة تجريبية تتيح لك تجربة شاشات تسجيل الدخول للمستخدمين النهائيين وشاشات المسؤولين في Authrim عمليًا.',
    intro2:
      'عند الضغط على «ابدأ» يُنشأ مستأجر (Tenant) خاص بك، ويمكنك تغيير إعداداته بحرية (مع وجود بعض العناصر التي لا يمكن تغييرها).',
    noticeTitle: 'يُرجى الانتباه',
    notices: (hours) => [
      'هذه بيئة تجريبية لأغراض الاختبار فقط.',
      'لا تُدخل بيانات شخصية حقيقية ولا بيانات اعتماد حقيقية.',
      `يُحذف كل ما تنشئه تلقائيًا بعد نحو ${arabicHours(hours)}.`,
    ],
    start: 'ابدأ',
    gateTitle: 'جارٍ تجهيز البيئة التجريبية',
    gateTitleReady: 'البيئة التجريبية جاهزة',
    gateChecking: 'جارٍ التحقق من طلبك',
    gateAccepted: 'جارٍ إنشاء البيئة',
    gateInviting: 'جارٍ تجهيز دعوة المسؤول',
    gateSlow: 'يستغرق الأمر وقتًا أطول من المعتاد. يُرجى إبقاء هذه الصفحة مفتوحة',
    gateUnstable: 'يبدو أن الاتصال غير مستقر. نواصل التحقق',
    gateOpening: 'جارٍ نقلك إلى وحدة تحكم المسؤول',
    gateArriving: 'البيئة جاهزة. سيظهر الزر بعد لحظات.',
    gateReady: 'البيئة جاهزة. استخدم الزر أدناه لفتح وحدة تحكم المسؤول.',
    skipLabel: 'تخطي العرض المتحرك',
    sealLabel: 'فتح وحدة تحكم المسؤول',
    gateLastMinute: 'يظل هذا الرابط صالحًا نحو دقيقة واحدة فقط. افتح وحدة تحكم المسؤول الآن.',
    gateExpired: 'انتهت المهلة المتاحة لفتح وحدة تحكم المسؤول. يُرجى البدء من جديد.',
    timeout: 'يستغرق الأمر وقتًا أطول من المتوقع. يُرجى البدء من جديد.',
    failed: 'تعذّر إنشاء البيئة التجريبية. يُرجى المحاولة مرة أخرى.',
    handedOff: 'تم فتح هذه البيئة بالفعل. إذا أغلقت تلك الصفحة، يُرجى البدء من جديد.',
    lost: 'تعذّر العثور على هذه الجلسة. يُرجى البدء من جديد.',
    retry: 'البدء من جديد',
    noscript: 'تحتاج هذه الصفحة إلى JavaScript لمتابعة التجهيز وفتح وحدة تحكم المسؤول نيابةً عنك.',
    errorTitle: 'تعذّرت المتابعة',
    errors: {
      forbidden: 'لم يُقبل الطلب. افتح صفحة البدء وحاول مجددًا من هناك.',
      bad_request: 'تعذّرت قراءة الطلب. ارجع إلى صفحة البدء وحاول مرة أخرى.',
      verification: 'فشل التحقق. ارجع وحاول مرة أخرى.',
      ip_limit: 'لقد بلغت الحد اليومي للبيئات التجريبية. يُرجى المحاولة غدًا.',
      capacity: 'البيئة التجريبية ممتلئة حاليًا. يُرجى المحاولة لاحقًا.',
      failed: 'تعذّر إنشاء البيئة التجريبية. يُرجى المحاولة لاحقًا.',
      config: 'البيئة التجريبية غير متاحة حاليًا. يُرجى المحاولة لاحقًا.',
      not_found: 'هذه الصفحة غير موجودة. ارجع إلى صفحة البدء.',
      method: 'هذه الطريقة غير مسموح بها هنا. ارجع إلى صفحة البدء.',
    },
    back: 'العودة إلى صفحة البدء',
  },
};

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** Best supported language of an Accept-Language header, or null when none is supported. */
function pickFromHeader(header: string | null): Lang | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) {
    const primary = entry.tag.split('-')[0];
    if (isLang(primary)) return primary;
  }
  return null;
}

/** Accept-Language only; English when nothing is supported. */
export function pickLang(header: string | null): Lang {
  return pickFromHeader(header) ?? 'en';
}

export const LANG_COOKIE = 'demo_lang';
const LANG_COOKIE_MAX_AGE = 31536000;

function readLangCookie(header: string | null): Lang | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === LANG_COOKIE) {
      const value = part.slice(index + 1).trim();
      return isLang(value) ? value : null;
    }
  }
  return null;
}

export interface LangChoice {
  lang: Lang;
  /** A valid `?lang=` that the cookie does not hold yet: the response should remember it. */
  remember: boolean;
}

/** Precedence: a valid `?lang`, then the cookie, then Accept-Language, then English. */
export function chooseLang(request: Request): LangChoice {
  const cookie = readLangCookie(request.headers.get('Cookie'));
  const queried = new URL(request.url).searchParams.get('lang');
  if (isLang(queried)) return { lang: queried, remember: queried !== cookie };
  if (cookie) return { lang: cookie, remember: false };
  return { lang: pickLang(request.headers.get('Accept-Language')), remember: false };
}

/** The value is one of the allowlisted codes; nothing from the request is ever copied in. */
export function langCookie(lang: Lang, secure: boolean): string {
  return `${LANG_COOKIE}=${lang}; Path=/; SameSite=Lax; Max-Age=${LANG_COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`;
}
