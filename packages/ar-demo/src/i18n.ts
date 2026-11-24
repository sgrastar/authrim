/** Languages, the typed message table and language selection. No HTML in here. */

/**
 * The languages of the admin console (ar-admin-console/src/lib/i18n/locales.ts). English, the
 * default, comes first in the language links.
 */
export const LANGS = ['en', 'ja', 'de', 'ar'] as const;
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
  /** The day or night button's name. */
  themeLabel: string;
  title: string;
  intro1: string;
  intro2: string;
  noticeTitle: string;
  /**
   * Six notes. The first four are the plain rules (the left column, under the heading); the last
   * two (where the database is, the second factor) are fine print (the right column).
   */
  notices: (hours: number) => [string, string, string, string, string, string];
  start: string;
  /** On the start button while the check is still answering. */
  startChecking: string;
  /**
   * Labels of the two numbers on the start page. The first counts every place that is taken
   * (being prepared, in use, or waiting to be cleaned up), so it does not say "running".
   */
  tallyActive: string;
  tallyCreated: string;
  /** The line above the link for a tenant that already exists. */
  adminLead: string;
  /** The link into the admin console's sign-in. */
  adminConsole: string;
  skipLabel: string;
  sealLabel: string;
  retry: string;
  noscript: string;
  errorTitle: string;
  errors: Record<ErrorKind, string>;
  back: string;
}

/**
 * Japanese strings carry their allowed line-break points as '|' in the source; this turns each into
 * a ZERO WIDTH SPACE (U+200B), the one phrase-wrapping technique that works in every browser
 * (word-break: auto-phrase is Chromium-only). The stylesheet forbids every other break.
 */
const p = (text: string): string => text.replaceAll('|', '\u200b');

/** Text without the break marks: for <title> and attributes. */
export function plain(text: string): string {
  return text.replaceAll('\u200b', '');
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
    themeLabel: '昼と夜を切り替える',
    title: 'Authrim デモ環境',
    intro1: p(
      'Authrim の|エンドユーザー向け|ログインと|管理者向けの|画面を、|実際に|操作して|試せる|マルチテナントの|デモ環境です。'
    ),
    intro2: p(
      '「開始する」を|押すと、|あなた専用の|テナントが|作成され、|設定を|自由に|変更できます|（一部、|変更できない|項目が|あります）。'
    ),
    noticeTitle: '注意',
    notices: (hours) => [
      p('これは|動作確認のための|デモ環境です。'),
      p('実際の|個人情報や|本物の|認証情報は|入力しないでください。'),
      p(`作成した|ものは|すべて、|約${hours}時間で|自動的に|削除されます。`),
      p('本環境は|開発中の|ものです。|一部|使用できない|機能等が|あります。'),
      p(
        '本マルチテナント環境では、|データベースが|APAC(アジア地域)と|なっています。|使用環境によっては|通信が|遅い|場合があります。'
      ),
      p(
        '重要な|操作を|行う|場合、|２つの|要素で|認証を|行う|ステップアップ認証を|採用しています。|本来、|２つ目の|認証では|Yubikeyなどの|ハードウェアを|使用した|許可か|専用スマホアプリでの|許可が|推奨されますが、|このデモ環境では|利便性を|考慮し、|6桁の|コードを|利用する|TOTP形式でも|登録可能です。'
      ),
    ],
    start: '開始する',
    startChecking: '確認しています…',
    tallyActive: p('使用中の|枠'),
    tallyCreated: p('これまでに|作られた|テナント'),
    adminLead: p('すでに|作成済みの|テナントの|管理画面は|こちらから'),
    adminConsole: 'Admin Console へ',
    gateTitle: p('デモ環境を|準備しています'),
    gateTitleReady: p('デモ環境の|準備が|できました'),
    gateChecking: p('受付を|確認しています'),
    gateAccepted: p('環境を|作成しています'),
    gateInviting: p('管理者の|招待を|準備しています'),
    gateSlow: p('時間が|かかっています。|このまま|お待ちください'),
    gateUnstable: p('通信が|不安定です。|確認を|続けています'),
    gateOpening: p('管理コンソールへ|移動します'),
    gateArriving: p('準備が|できました。|まもなく|ボタンが|表示されます。'),
    gateReady: p('準備が|できました。|下の|ボタンで|管理コンソールを|開きます。'),
    skipLabel: '演出を省略',
    sealLabel: '管理コンソールを開く',
    gateLastMinute: p(
      'このリンクは|あと約1分で|使えなくなります。|今すぐ|管理コンソールを|開いてください。'
    ),
    gateExpired: p('管理コンソールを|開く|時間が|過ぎました。|最初から|やり直してください。'),
    timeout: p('時間が|かかりすぎています。|最初から|やり直してください。'),
    failed: p('デモ環境を|作成できませんでした。|もう一度|お試しください。'),
    handedOff: p(
      'この環境は|すでに|開かれています。|ページを|閉じた場合は、|最初から|やり直してください。'
    ),
    lost: p('この|セッションが|見つかりません。|最初から|やり直してください。'),
    retry: p('最初から|やり直す'),
    noscript: p(
      'このページでは、|準備の|進み具合を|確認して|管理コンソールを|開くために|JavaScript が|必要です。'
    ),
    errorTitle: p('続行できません'),
    errors: {
      forbidden: p(
        'リクエストは|受け付けられませんでした。|開始ページを|開き、|そこから|もう一度|お試しください。'
      ),
      bad_request: p(
        'リクエストを|読み取れませんでした。|開始ページに|戻って、|もう一度|お試しください。'
      ),
      verification: p('確認に|失敗しました。|前の画面に|戻って、|もう一度|お試しください。'),
      ip_limit: p('1日に|作成できる|デモ環境の|上限に|達しました。|明日|もう一度|お試しください。'),
      capacity: p('現在、|デモ環境は|満員です。|しばらくしてから|もう一度|お試しください。'),
      failed: p('デモ環境を|作成できませんでした。|しばらくしてから|もう一度|お試しください。'),
      config: p(
        '現在、|デモ環境を|ご利用|いただけません。|しばらくしてから|もう一度|お試しください。'
      ),
      not_found: p('ページが|見つかりません。|開始ページに|戻ってください。'),
      method: p('ここでは|この|メソッドは|使えません。|開始ページに|戻ってください。'),
    },
    back: p('開始ページへ|戻る'),
  },
  en: {
    name: 'English',
    htmlLang: 'en',
    dir: 'ltr',
    turnstile: 'en',
    languageLabel: 'Language',
    themeLabel: 'Switch between day and night',
    title: 'Authrim Demo',
    intro1:
      'A multi-tenant demo environment where you can try Authrim’s end-user sign-in and administrator screens hands-on.',
    intro2:
      'Press “Start” to create a tenant of your own, where you can change settings freely (a few items cannot be changed).',
    noticeTitle: 'Please note',
    notices: (hours) => [
      'This is a demo environment for testing only.',
      'Do not enter real personal data or real credentials.',
      `Everything you create is deleted automatically after about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
      'This environment is still under development, so some features are not available.',
      'In this multi-tenant environment the database is in APAC (Asia-Pacific). Depending on where you are, connections may be slow.',
      'Important operations use step-up authentication, which asks for two factors. A second factor from hardware such as a YubiKey, or approval in a dedicated phone app, is normally recommended, but for convenience this demo also lets you register a TOTP authenticator (a 6-digit code).',
    ],
    start: 'Start',
    startChecking: 'Checking…',
    tallyActive: 'Demo slots in use',
    tallyCreated: 'Tenants created so far',
    adminLead: 'To open the admin console of a tenant you have already created, go here',
    adminConsole: 'Go to the Admin Console',
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
    themeLabel: 'Zwischen Tag und Nacht wechseln',
    title: 'Authrim Demo',
    intro1:
      'Eine Multi-Tenant-Demo-Umgebung, in der du die Anmeldung für Endnutzer und die Verwaltungsoberfläche von Authrim direkt ausprobieren kannst.',
    intro2:
      'Mit „Starten“ wird ein eigener Tenant für dich angelegt, dessen Einstellungen du frei ändern kannst (einige wenige Punkte sind nicht änderbar).',
    noticeTitle: 'Bitte beachten',
    notices: (hours) => [
      'Dies ist eine Demo-Umgebung nur zum Ausprobieren.',
      'Gib keine echten personenbezogenen Daten und keine echten Zugangsdaten ein.',
      `Alles, was du anlegst, wird nach etwa ${hours} ${hours === 1 ? 'Stunde' : 'Stunden'} automatisch gelöscht.`,
      'Diese Umgebung befindet sich noch in Entwicklung, daher sind einige Funktionen nicht verfügbar.',
      'In dieser Multi-Tenant-Umgebung liegt die Datenbank in APAC (Asien-Pazifik). Je nach Standort können Verbindungen langsam sein.',
      'Für wichtige Vorgänge wird eine Step-up-Authentifizierung mit zwei Faktoren verwendet. Als zweiter Faktor wird eigentlich Hardware wie ein YubiKey oder die Freigabe in einer eigenen Smartphone-App empfohlen; in dieser Demo kannst du aus Bequemlichkeit auch eine TOTP-Authenticator-App (6-stelliger Code) registrieren.',
    ],
    start: 'Starten',
    startChecking: 'Wird geprüft…',
    tallyActive: 'Belegte Demo-Plätze',
    tallyCreated: 'Bisher angelegte Tenants',
    adminLead: 'Zur Verwaltungsoberfläche eines bereits angelegten Tenants geht es hier',
    adminConsole: 'Zur Admin Console',
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
    themeLabel: 'التبديل بين النهار والليل',
    title: 'بيئة Authrim التجريبية',
    intro1:
      'بيئة تجريبية متعددة المستأجرين (Multi-tenant) تتيح لك تجربة شاشات تسجيل الدخول للمستخدمين النهائيين وشاشات المسؤولين في Authrim عمليًا.',
    intro2:
      'عند الضغط على «ابدأ» يُنشأ مستأجر (Tenant) خاص بك، ويمكنك تغيير إعداداته بحرية (مع وجود بعض العناصر التي لا يمكن تغييرها).',
    noticeTitle: 'يُرجى الانتباه',
    notices: (hours) => [
      'هذه بيئة تجريبية لأغراض الاختبار فقط.',
      'لا تُدخل بيانات شخصية حقيقية ولا بيانات اعتماد حقيقية.',
      `يُحذف كل ما تنشئه تلقائيًا بعد نحو ${arabicHours(hours)}.`,
      'هذه البيئة ما زالت قيد التطوير، لذا بعض الميزات غير متاحة.',
      'في هذه البيئة متعددة المستأجرين توجد قاعدة البيانات في منطقة APAC (آسيا والمحيط الهادئ). قد يكون الاتصال بطيئًا بحسب مكان استخدامك.',
      'تعتمد العمليات المهمة المصادقة المعزّزة (Step-up) بعاملين. يُفضَّل عادةً أن يكون العامل الثاني عبر جهاز مثل YubiKey أو الموافقة من تطبيق هاتف مخصص، لكن هذه البيئة التجريبية تتيح لك للتيسير تسجيل تطبيق TOTP (رمز من 6 أرقام).',
    ],
    start: 'ابدأ',
    startChecking: 'جارٍ التحقق…',
    tallyActive: 'الأماكن المشغولة الآن',
    tallyCreated: 'المستأجرون المُنشَؤون حتى الآن',
    adminLead: 'للدخول إلى لوحة إدارة مستأجر أنشأتَه من قبل، تفضّل من هنا',
    adminConsole: 'إلى Admin Console',
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
