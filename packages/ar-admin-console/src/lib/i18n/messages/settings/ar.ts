import type { jaSettings } from './ja';

export const arSettings: Record<keyof typeof jaSettings, string> = {
	'set.page.stayingSignedIn': 'البقاء مسجلاً للدخول',
	'set.page.stayingSignedIn.desc':
		'المدة التي يبقى فيها الأشخاص مسجلين للدخول بعد تسجيل دخولهم، والمدة التي تحتفظ فيها تطبيقاتهم بهذا الدخول.',

	'set.section.signIn': 'مدة تسجيل الدخول',
	'set.section.signIn.desc': 'المدة التي يبقى فيها الشخص مسجلاً للدخول إلى Authrim.',
	'set.section.signIn.advanced': 'المدة لكل طريقة تسجيل دخول، والنطاق المسموح',
	'set.section.appTokens': 'الرموز المميزة للتطبيقات',
	'set.section.appTokens.desc':
		'مدة صلاحية الرموز التي تتيح للتطبيقات مواصلة استخدام تسجيل الدخول.',
	'set.section.appTokens.advanced': 'رموز الهوية، وطريقة تجديد رموز التحديث',
	'set.section.logout': 'إشعارات تسجيل الخروج',
	'set.section.logout.desc':
		'ما يحدث عندما يُبلغ Authrim التطبيقات بأن شخصاً سجّل خروجه (تسجيل الخروج عبر القناة الخلفية).',
	'set.section.logout.advanced': 'عند عدم وصول الإشعار، وإعادة المحاولة',

	'set.k.session.default_ttl': 'إبقاء الأشخاص مسجلين للدخول لمدة',
	'set.k.session.default_ttl.desc':
		'المدة من تسجيل الدخول حتى يحتاج الشخص إلى تسجيل الدخول مرة أخرى. لتحديدها لكل طريقة، استخدم الإعدادات المتقدمة.',
	'set.k.session.refresh_default': 'تمديد تسجيل الدخول أثناء استخدامه',
	'set.k.session.refresh_default.desc': 'كل إجراء يبدأ المدة من جديد (ما لم يطلب التطبيق غير ذلك).',
	'set.k.oauth.sso_enabled': 'مشاركة تسجيل الدخول بين التطبيقات (تسجيل الدخول الموحد)',
	'set.k.oauth.sso_enabled.desc':
		'بعد تسجيل الدخول مرة واحدة، يفتح الشخص تطبيقات المستأجر الأخرى دون تسجيل الدخول مجدداً. عند الإيقاف: يطلب كل تطبيق تسجيل الدخول.',
	'set.k.session.ttl.passkey': 'بعد تسجيل الدخول بمفتاح مرور',
	'set.k.session.ttl.email_code': 'بعد تسجيل الدخول برمز البريد الإلكتروني',
	'set.k.session.ttl.directory_password': 'بعد تسجيل الدخول بكلمة مرور الدليل',
	'set.k.session.ttl.direct_auth': 'بعد تسجيل الدخول عبر Direct Auth',
	'set.k.session.ttl.did': 'بعد تسجيل الدخول بمعرّف لامركزي (DID)',
	'set.k.session.ttl.guest': 'بعد تسجيل الدخول كضيف',
	'set.k.session.ttl.passkey_registration': 'مباشرة بعد تسجيل مفتاح مرور',
	'set.k.session.max_ttl': 'أطول مدة دخول مسموحة',
	'set.k.session.max_ttl.desc': 'أطول مدة يمكن تحديدها للبقاء مسجلاً للدخول.',
	'set.k.session.min_ttl': 'أقصر مدة دخول مسموحة',
	'set.k.session.min_ttl.desc': 'أقصر مدة يمكن تحديدها للبقاء مسجلاً للدخول.',
	'set.k.session.token_ttl': 'مدة صلاحية رمز الجلسة',
	'set.k.session.token_ttl.desc': 'مدة صلاحية الرمز المستخدم لإدارة الجلسات.',
	'set.k.session.tombstone_ttl': 'تذكّر الجلسات المنتهية لمدة',
	'set.k.session.tombstone_ttl.desc':
		'المدة التي تُتذكّر فيها الجلسة المنتهية (بتسجيل الخروج مثلاً) لرفضها.',

	'set.k.oauth.access_token_expiry': 'مدة صلاحية رمز الوصول',
	'set.k.oauth.access_token_expiry.desc':
		'الرمز الذي يستخدمه التطبيق لاستدعاء واجهات البرمجة. كلما قصرت مدته، قلّ ما يمكن فعله برمز مسرّب.',
	'set.k.oauth.refresh_token_expiry': 'مدة صلاحية رمز التحديث',
	'set.k.oauth.refresh_token_expiry.desc':
		'المدة التي يحصل فيها التطبيق على رموز وصول جديدة دون أن يطلب من الشخص تسجيل الدخول مجدداً.',
	'set.k.oauth.id_token_expiry': 'مدة صلاحية رمز الهوية',
	'set.k.oauth.id_token_expiry.desc': 'الرمز الذي يُبلغ التطبيق بمن سجّل الدخول.',
	'set.k.oauth.refresh_token_rotation': 'استبدال رمز التحديث في كل مرة يُستخدم فيها',
	'set.k.oauth.refresh_token_rotation.desc':
		'يتوقف الرمز المستخدم عن العمل، فلا يمكن إعادة استخدام رمز مسرّب. يُنصح بإبقاء هذا الخيار مفعّلاً.',
	'set.k.oauth.refresh_token_sliding_window_enabled': 'تمديد الصلاحية في كل مرة يُستخدم فيها',
	'set.k.oauth.refresh_token_sliding_window_enabled.desc':
		'كل استخدام لرمز التحديث يبدأ مدة صلاحيته من جديد.',
	'set.k.oauth.refresh_token_absolute_expiry_enabled': 'تحديد حدّ لا يتجاوزه التمديد',
	'set.k.oauth.refresh_token_absolute_expiry_enabled.desc':
		'يحدّ المدة منذ إصدار أول رمز. بعدها يسجّل الشخص الدخول مجدداً.',
	'set.k.oauth.refresh_token_absolute_expiry': 'الحد (من أول رمز)',
	'set.k.oauth.refresh_token_remaining_expiry_inherit':
		'يحتفظ الرمز الجديد بالمدة المتبقية من القديم',
	'set.k.oauth.refresh_token_remaining_expiry_inherit.desc':
		'عند الإيقاف: تبدأ صلاحية الرمز الجديد عند إصداره.',
	'set.k.oauth.offline_access_required': 'الإصدار فقط للتطبيقات التي تطلب offline_access',
	'set.k.oauth.offline_access_required.desc':
		'عند الإيقاف: تُصدر رموز التحديث أياً كانت النطاقات التي يطلبها التطبيق.',
	'set.k.oauth.refresh_id_token_reissue': 'إصدار رمز هوية جديد عند التحديث أيضاً',

	'set.k.session.backchannel_on_failure': 'عند عدم وصول الإشعار',
	'set.k.session.backchannel_on_failure.desc': 'ما يجب فعله إذا لم تُوصل إعادة المحاولة الإشعار.',
	'set.k.session.backchannel_on_failure.ignore': 'لا شيء',
	'set.k.session.backchannel_on_failure.log': 'تسجيله في السجل',
	'set.k.session.backchannel_on_failure.error': 'معاملته كخطأ',
	'set.k.session.backchannel_retry_max_attempts': 'عدد مرات إعادة المحاولة',
	'set.k.session.backchannel_logout_token_exp': 'مدة صلاحية رمز تسجيل الخروج',
	'set.k.session.backchannel_request_timeout_ms': 'انتظار رد التطبيق لمدة',
	'set.k.session.backchannel_retry_initial_delay_ms': 'الوقت قبل أول إعادة محاولة',
	'set.k.session.backchannel_retry_max_delay_ms': 'أطول وقت بين محاولتين',
	'set.k.session.backchannel_retry_backoff_multiplier': 'معامل إطالة الوقت بين المحاولات',

	'settings.advanced': 'متقدم',
	'settings.setHere': 'الإعدادات المتجاوزة: {n}',
	'settings.readOnly.title': 'عرض فقط',
	'settings.readOnly.body':
		'لا يمكنك تغيير هذه الإعدادات. لتغييرها، اطلب ذلك من مسؤول يملك الصلاحية.',
	'settings.rejected': 'تعذّر حفظ هذه القيمة ({reason})',
	'settings.partial': 'تعذّر حفظ بعض الإعدادات. راجع الإعدادات المميزة.',
	'settings.setHereOption': 'تجاوز الإعداد',
	'settings.defaultFrom.platform': 'الافتراضي للمنصة: {value}',
	'settings.defaultFrom.tenant': 'الافتراضي للمستأجر: {value}',
	'settings.locked.platform': 'قيمة ثابتة بإعدادات المنصة',
	'settings.locked.tenant': 'قيمة ثابتة بإعدادات المستأجر',
	'settings.badge.locked': 'مقفل',
	'settings.badge.here': 'متجاوز',
	'settings.value.on': 'مفعّل',
	'settings.value.off': 'متوقف',
	'settings.value.empty': '(لا شيء)',
	'settings.conflict.title': 'حفظ مسؤول آخر أولاً',
	'settings.conflict.body': 'منذ أن فتحت هذه الصفحة، غيّر مسؤول آخر هذه الإعدادات:',
	'settings.conflict.reload': 'تحميل أحدث القيم',
	'settings.conflict.reload.desc': 'ستُتجاهل تغييراتك.',
	'settings.conflict.overwrite': 'حفظ تغييراتي فوقها',
	'settings.conflict.overwrite.desc': 'تُحفظ الإعدادات التي غيّرتها فقط، فوق أحدث القيم.',

	'inherit.usingDeployment': 'يُستخدم إعداد النشر',
	'inherit.sourceBuiltIn': 'Authrim',

	'access.none.title': 'لا يمكنك عرض هذه الصفحة',
	'access.none.body': 'افتح صفحة أخرى، أو اطلب ذلك من مسؤول يملك الصلاحية.',
	'load.error.title': 'تعذّر التحميل',
	'load.error.body': 'حاول مرة أخرى بعد قليل.',
	'load.retry': 'إعادة المحاولة',

	'persona.label': 'نوع المسؤول',
	'persona.platform': 'مسؤول المنصة',
	'persona.platform.desc': 'يدير التثبيت بأكمله: كل المستأجرين والمنصة.',
	'persona.tenant': 'مسؤول المستأجر',
	'persona.tenant.desc': 'يدير مستأجراً واحداً: مستخدميه وتطبيقاته وإعداداته.',
	'persona.support': 'الدعم (محدود)',
	'persona.support.desc': 'يساعد المستخدمين فقط (إلغاء القفل، تسجيل الخروج). لا يرى الإعدادات.',
	'persona.viewer': 'مشاهد (محدود)',
	'persona.viewer.desc': 'يرى المستخدمين والتطبيقات والإعدادات، ولا يغيّر شيئاً.'
};
