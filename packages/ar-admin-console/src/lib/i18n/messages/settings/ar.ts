import type { jaSettings } from './ja';

export const arSettings: Record<keyof typeof jaSettings, string> = {
	'set.page.team': 'المسؤولون',
	'set.page.team.desc': 'كيف يسجّل المسؤولون الدخول إلى وحدة التحكم هذه.',
	'set.section.adminSignIn': 'تسجيل دخول المسؤولين',
	'set.section.adminSignIn.desc':
		'المدة التي يبقى فيها مسؤولو هذا المستأجر مسجّلين، والتحققات المطلوبة قبل أي عملية.',
	'set.section.adminSignInPlatform': 'تسجيل دخول المسؤولين لكل المستأجرين',
	'set.section.adminSignInPlatform.desc':
		'ينطبق على مسؤولي كل المستأجرين. لا يغيّره إلا مسؤولو المنصة.',
	'set.section.adminInvitationsPlatform': 'رموز دعوات المسؤولين',
	'set.section.adminInvitationsPlatform.desc':
		'تحدد ما إذا كان رمز دعوة المسؤول يُسلَّم إلى جهاز آلي بدلاً من إرساله بالبريد الإلكتروني. يسري على كل المستأجرين. لا يمكن تغييره إلا لمسؤولي المنصة.',
	'set.k.admin_invitations.code_handoff_enabled': 'تسليم رمز الدعوة إلى جهاز موثوق',
	'set.k.admin_invitations.code_handoff_enabled.desc':
		'عند التشغيل، يمكن لبيانات اعتماد آلية تملك الصلاحية المخصصة إنشاء دعوة مسؤول واستلام رمزها في استجابة API بدلاً من البريد الإلكتروني. ولا يُعدّ البريد الإلكتروني للمدعو موثّقاً حينها. أما الدعوات المنشأة من هذه الوحدة فتُرسل بالبريد الإلكتروني كما كانت. يتطلب التشغيل تحققاً إضافياً من الهوية (step-up)، بينما لا يتطلب الإيقاف ذلك.',
	'settings.notice.codeHandoff.title': 'تُسلَّم الرموز دون بريد إلكتروني',
	'settings.notice.codeHandoff.body':
		'يستلم الجهاز الذي يملك الصلاحية رمز التسجيل مباشرة. أوقف هذا الخيار إذا لم تكن أي أتمتة تحتاج إليه.',
	'settings.stepUpCancelled': 'أُلغي التحقق من الهوية. ما زالت بعض التغييرات غير محفوظة.',
	'set.k.session.ttl.admin_passkey': 'مدة تسجيل دخول المسؤولين بمفتاح المرور',
	'set.k.session.ttl.admin_passkey.desc':
		'المدة بعد تسجيل الدخول بمفتاح مرور قبل أن يُطلب من المسؤول تسجيل الدخول مجددًا.',
	'set.k.security.admin_step_up_overrides': 'تحققات مرفوعة لكل عملية',
	'set.k.security.admin_step_up_overrides.desc':
		'أسماء العمليات مع التحقق المطلوب (L1: مفتاح مرور؛ L2: مفتاح مرور وعامل ثانٍ)، مثل {"client.secret.rotate": "L2"}. لا يمكن خفض المستوى عن المستوى المضمّن.',
	'set.k.security.admin_step_up_enforced': 'طلب تحققات إضافية قبل عمليات الإدارة',
	'set.k.security.admin_step_up_enforced.desc':
		'عند الإيقاف تُتخطّى تحققات مفتاح المرور والعامل الثاني قبل عمليات الإدارة الحساسة. أوقفه أثناء الترحيل فقط؛ الإيقاف نفسه يتطلب تحقق L2.',
	'set.k.security.admin_keyring_dc_api': 'تقديم Keyring عبر المتصفح',
	'set.k.security.admin_keyring_dc_api.desc':
		'حيث يدعم المتصفح ذلك، يقدّم المسؤولون بيانات اعتماد Keyring عبر Digital Credentials API بدلًا من رمز QR.',
	'set.k.security.admin_last_resort_reenroll_window_seconds':
		'مدة إعادة التسجيل بعد الاسترداد الأخير',
	'set.k.security.admin_last_resort_reenroll_window_seconds.desc':
		'بعد أن يلغي الاسترداد الأخير العوامل الثانية للمسؤول، المدة التي يمكنه خلالها تسجيل عامل أول من جديد باستخدام مفتاح المرور وحده.',
	'settings.json.object': 'أدخل كائن JSON (بين القوسين { }).',
	'set.page.sessionProfiles': 'ملفات تعريف الجلسة',
	'set.page.sessionProfiles.desc':
		'المدة التي يبقى فيها الشخص مسجلاً للدخول بعد تسجيل دخوله، وتسجيل الدخول الموحد.',
	'set.page.logout.desc':
		'كيف تُبلَّغ التطبيقات بأن شخصاً ما سجّل خروجه. عناوين تسجيل الخروج الخاصة بكل تطبيق تتبع التطبيق نفسه.',
	'set.page.logout': 'تسجيل الخروج',
	'set.page.signingKeys': 'مفاتيح التوقيع',
	'set.page.signingKeys.desc': 'كيف يوقّع هذا المستأجر رموزه.',
	'set.section.idTokenSigning': 'توقيع رموز الهوية',
	'set.section.idTokenSigning.desc':
		'الخوارزمية التي تُوقَّع بها رموز الهوية، وهل يمكن للتطبيقات اختيار خوارزميتها.',

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
		'المدة حتى يحتاج الشخص إلى تسجيل الدخول مرة أخرى، لعمليات تسجيل الدخول التي ليست لها مدة خاصة بها، مثل موفر هوية خارجي أو SAML. حدّد مدد مفاتيح المرور ورموز البريد الإلكتروني والطرق الأخرى في الإعدادات المتقدمة.',
	'set.k.session.refresh_default': 'تمديد تسجيل الدخول أثناء استخدامه',
	'set.k.session.refresh_default.desc':
		'عندما يطلب التطبيق تمديد تسجيل الدخول (/api/sessions/refresh)، تبدأ المدة من جديد من تلك اللحظة. عند الإيقاف: لا تمديد. لا يتجاوز التمديد أطول مدة للبقاء مسجلاً للدخول.',
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
	'set.k.session.max_ttl.desc':
		'أطول مدة يبقى فيها تسجيل الدخول، بما في ذلك التمديدات. تُقصَّر المدة الأطول لأي طريقة إليها.',

	'set.k.oauth.access_token_expiry': 'مدة صلاحية رمز الوصول',
	'set.k.oauth.access_token_expiry.desc':
		'الرمز الذي يستخدمه التطبيق لاستدعاء واجهات البرمجة. كلما قصرت مدته، قلّ ما يمكن فعله برمز مسرّب.',
	'set.k.oauth.refresh_token_expiry': 'مدة صلاحية رمز التحديث',
	'set.k.oauth.refresh_token_expiry.desc':
		'المدة التي يحصل فيها التطبيق على رموز وصول جديدة دون أن يطلب من الشخص تسجيل الدخول مجدداً.',
	'set.k.oauth.id_token_expiry': 'مدة صلاحية رمز الهوية',
	'set.k.oauth.id_token_expiry.desc': 'الرمز الذي يُبلغ التطبيق بمن سجّل الدخول.',
	'set.k.oauth.refresh_token_rotation': 'استبدال رمز التحديث في كل مرة يُستخدم فيها',
	'set.k.oauth.id_token_signing_alg': 'خوارزمية توقيع رموز الهوية',
	'set.k.oauth.id_token_signing_alg.desc':
		'تُوقّع رموز الهوية للتطبيقات التي لا تختار خوارزميتها بنفسها.',
	'set.k.oauth.id_token_signing_alg_client_override': 'السماح للتطبيقات باختيار خوارزميتها',
	'set.k.oauth.id_token_signing_alg_client_override.desc':
		'عند الإيقاف: يُوقَّع كل رمز هوية بخوارزمية المستأجر، ويُرفض تسجيل التطبيقات بخوارزمية أخرى.',
	'set.k.security.fapi_enabled': 'تطبيق FAPI 2.0',
	'set.k.security.fapi_enabled.desc': 'تطبيق ملف أمان FAPI 2.0 على كل تطبيقات المستأجر.',
	'set.page.tokens': 'الرموز المميزة والبروتوكولات',
	'set.page.tokens.desc':
		'مدة صلاحية الرموز المميزة التي تحصل عليها التطبيقات، وما يجب أن يستوفيه كل تطبيق، والإعدادات الافتراضية للبروتوكولات. يمكن لكل تطبيق تجاوزها (ولا يمكن التنازل عن أي متطلب).',
	'set.section.authRequests': 'طلبات التفويض',
	'set.section.authRequests.desc': 'ما يجب أن يتضمنه طلب تسجيل الدخول من التطبيق.',
	'set.section.authRequests.advanced': 'كائنات الطلب الموقّعة والمشفّرة',
	'set.section.redirectUris': 'عناوين إعادة التوجيه',
	'set.section.redirectUris.desc': 'الأماكن التي قد يعود إليها تسجيل الدخول في التطبيق.',
	'set.section.senderConstrained': 'الرموز المقيدة بالمرسل',
	'set.section.senderConstrained.desc': 'رموز مرتبطة بمفتاح التطبيق الذي استلمها.',
	'set.section.senderConstrained.advanced': 'DPoP مع FAPI وقيم nonce',
	'set.section.fapi': 'FAPI',
	'set.section.fapi.desc': 'ملف الأمان من الدرجة المالية (FAPI 2.0).',
	'set.section.fapi.advanced': 'متطلبات FAPI التفصيلية',
	'set.section.tokenExchange': 'تبادل الرموز',
	'set.section.tokenExchange.desc': 'استبدال رمز يحمله التطبيق برمز آخر.',
	'set.section.tokenExchange.advanced': 'التفويض وانتحال الهوية',
	'set.k.security.pkce_required': 'اشتراط PKCE',
	'set.k.security.pkce_required.desc':
		'يجب أن يتضمن كل طلب رمز تفويض PKCE (S256). يمكن للتطبيق اشتراطه أيضًا، لكن لا يمكنه إلغاء اشتراط المستأجر.',
	'set.k.security.par_required': 'اشتراط PAR',
	'set.k.security.par_required.desc':
		'يجب دفع طلبات التفويض أولًا من خادم إلى خادم (Pushed Authorization Request).',
	'set.k.oauth.state_required': 'اشتراط معامل state',
	'set.k.oauth.state_required.desc': 'رفض طلبات التفويض التي لا تحتوي على state (حماية CSRF).',
	'set.k.oauth.prompt_create_enabled': 'فتح صفحة التسجيل عند prompt=create',
	'set.k.oauth.prompt_create_enabled.desc':
		'يصل التطبيق الذي يطلب إنشاء حساب (prompt=create) إلى صفحة التسجيل بدلاً من صفحة تسجيل الدخول. يتطلب تفعيل طريقة تسجيل (مفتاح المرور أو رمز البريد أو تطبيق المصادقة)؛ وإلا يجري تسجيل الدخول كالمعتاد. وتدرج خاصية الاكتشاف القيمة create ضمن قيم prompt.',
	'set.k.security.require_signed_request_object': 'اشتراط كائنات طلب موقّعة',
	'set.k.security.require_signed_request_object.desc':
		'يجب أن تصل طلبات التفويض في كائن طلب وقّعه التطبيق.',
	'set.k.security.require_encrypted_request_object': 'اشتراط كائنات طلب مشفّرة',
	'set.k.security.require_encrypted_request_object.desc':
		'يجب أن تصل طلبات التفويض في كائن طلب مشفّر بمفتاح التشفير الخاص بالمستأجر (use enc في JWKS). يجب أن تدعم التطبيقات ذلك.',
	'set.k.security.allow_unsigned_request_object': 'السماح بكائنات طلب غير موقّعة (للتطوير)',
	'set.k.security.allow_unsigned_request_object.desc':
		'غير مسموح بها أبدًا في بيئة الإنتاج مهما كان هذا الإعداد.',
	'set.k.security.https_redirect_only': 'السماح فقط بعناوين إعادة توجيه HTTPS',
	'set.k.security.https_redirect_only.desc':
		'يمكن للتطبيق الأصلي استخدام http على عنوان الاسترجاع (مثل localhost). عند الإيقاف: يمكن لتطبيق الويب أيضًا استخدام http على مضيف الاسترجاع (للتطوير).',
	'set.k.security.dpop_bound_access_tokens': 'ربط رموز الوصول بـ DPoP',
	'set.k.security.dpop_bound_access_tokens.desc':
		'يلزم إثبات DPoP للحصول على الرموز، حتى لا يتمكن أي شخص آخر من استخدام رمز مسرّب. يجب أن تدعم التطبيقات ذلك.',
	'set.k.security.dpop_required': 'DPoP مع FAPI',
	'set.k.security.dpop_required.desc': 'ما إذا كان DPoP مطلوبًا أثناء تطبيق FAPI.',
	'set.k.security.dpop_required.with_fapi': 'مطلوب مع FAPI',
	'set.k.security.dpop_required.always': 'مطلوب دائمًا',
	'set.k.security.dpop_required.never': 'غير مطلوب أبدًا',
	'set.k.security.dpop_nonce_enabled': 'استخدام nonce الخادم لـ DPoP',
	'set.k.security.dpop_nonce_enabled.desc':
		'يجب أن تتضمن إثباتات DPoP قيمة nonce أصدرها الخادم، مما يمنع إعادة استخدامها.',
	'set.k.security.fapi_strict_dpop': 'التحقق الصارم من DPoP',
	'set.k.security.fapi_strict_dpop.desc': 'رفض طلب التفويض الذي يكون إثبات DPoP فيه غير صالح.',
	'set.k.security.fapi_allow_public_clients': 'السماح بالعملاء العامين',
	'set.k.security.fapi_allow_public_clients.desc':
		'السماح بالتطبيقات بلا سر (تطبيقات المتصفح والجوال) أثناء تطبيق FAPI.',
	'set.k.security.fapi_require_private_key_jwt': 'اشتراط private_key_jwt',
	'set.k.security.fapi_require_private_key_jwt.desc':
		'تصادق التطبيقات باستخدام private_key_jwt فقط.',
	'set.k.security.require_jarm': 'اشتراط استجابات تفويض موقّعة (JARM)',
	'set.k.tokens.exchange_enabled': 'تفعيل تبادل الرموز',
	'set.k.tokens.exchange_enabled.desc': 'يمكن للتطبيقات استبدال رمز تحمله برمز آخر (RFC 8693).',
	'set.k.tokens.exchange_delegation_enabled': 'السماح بالتفويض',
	'set.k.tokens.exchange_delegation_enabled.desc':
		'يمكن للتطبيق الحصول على رمز لخدمة أخرى نيابةً عن شخص. ما دام هذا الخيار متوقفًا، تُرفض عملية تبادل الرموز للتطبيقات في وضع التفويض (الافتراضي). ويمكن لوضع التفويض الخاص بكل تطبيق تقييده أكثر.',
	'set.k.tokens.exchange_impersonation_enabled': 'السماح بانتحال الهوية',
	'set.k.tokens.exchange_impersonation_enabled.desc':
		'يمكن للتطبيق الحصول على رمز يتصرف بصفته الشخص نفسه. ما دام هذا الخيار متوقفًا، تُرفض عملية تبادل الرموز للتطبيقات في وضع انتحال الهوية. له أثر أمني كبير، فلا تفعّله إلا عند الحاجة.',
	'set.page.protection': 'الحماية من الهجمات',
	'set.page.protection.desc':
		'تمنع إساءة استخدام رسائل البريد الإلكتروني ورموز تطبيق المصادقة الخاصة بتسجيل الدخول والتسجيل.',
	'set.section.emailSending': 'حد إرسال البريد الإلكتروني',
	'set.section.emailSending.desc':
		'يحدّ من عدد مرات إرسال رسائل مثل رموز تسجيل الدخول إلى المستلم نفسه تباعًا، حتى لا تُستخدم في إرسال رسائل مزعجة.',
	'set.k.rate_limit.email_max_requests': 'عدد مرات الإرسال المسموح في الفترة',
	'set.k.rate_limit.email_max_requests.desc':
		'عدد رموز تسجيل الدخول والتسجيل وإعادة المصادقة وترحيل الدليل التي يمكن إرسالها إلى عنوان البريد الإلكتروني نفسه (أو المستخدم نفسه). لرموز اكتشاف الحساب حدّ مستقل.',
	'set.k.rate_limit.email_window': 'الفترة التي يُحتسب فيها الإرسال',
	'set.k.rate_limit.email_window.desc':
		'الفترة التي يُحتسب فيها العدد أعلاه (من 5 إلى 60 دقيقة). بعد انقضائها يُسمح بالإرسال من جديد.',
	'set.section.failedSignIns': 'محاولات تسجيل الدخول الفاشلة',
	'set.section.failedSignIns.desc':
		'يقفل الحساب لبعض الوقت بعد إدخال كلمة مروره خطأً مرات كثيرة متتالية، حتى لا يمكن تخمينها.',
	'set.k.rate_limit.auth_max_failed_attempts': 'المحاولات الفاشلة قبل القفل',
	'set.k.rate_limit.auth_max_failed_attempts.desc':
		'عدد كلمات المرور الخاطئة (تسجيل الدخول عبر الدليل) خلال 15 دقيقة، يُقفل بعدها الحساب لبقية تلك الدقائق الخمس عشرة (من 3 إلى 20).',
	'set.section.totpAttempts': 'محاولات تطبيق المصادقة',
	'set.section.totpAttempts.desc':
		'يحدّ من عدد مرات بدء تسجيل الدخول بتطبيق المصادقة، حتى لا تُخمَّن الرموز بكثرة المحاولات.',
	'set.k.rate_limit.totp_max_requests': 'عدد المحاولات المسموح في الفترة',
	'set.k.rate_limit.totp_max_requests.desc':
		'عدد مرات بدء تسجيل الدخول (وإعادة المصادقة) بتطبيق المصادقة لاسم الحساب نفسه من عنوان الشبكة نفسه، وعدد الرموز التي يمكن للتسجيل التحقق منها منه. كل بدء يسمح بإدخال رمز واحد.',
	'set.k.rate_limit.totp_window': 'الفترة التي تُحتسب فيها المحاولات',
	'set.k.rate_limit.totp_window.desc':
		'الفترة التي يُحتسب فيها العدد أعلاه (من 1 إلى 60 دقيقة). بعد انقضائها يُسمح بالمحاولة من جديد.',
	'set.k.rate_limit.email_tenant_hourly_max': 'عدد رسائل البريد لكل مستأجر في الساعة',
	'set.k.rate_limit.email_tenant_hourly_max.desc':
		'عدد رسائل البريد الإلكتروني التي يمكن لمستأجر واحد إرسالها في الساعة، بما فيها إشعارات الأمان والدعوات. عند تجاوز الحد تُرفض رسائل هذا المستأجر حتى الساعة التالية. القيمة 0 توقف هذا الحد. إعداد على مستوى المنصة، والافتراضي 2000.',
	'set.k.rate_limit.email_deployment_hourly_max': 'عدد رسائل البريد للبيئة كلها في الساعة',
	'set.k.rate_limit.email_deployment_hourly_max.desc':
		'عدد رسائل البريد الإلكتروني التي يمكن للبيئة كلها إرسالها في الساعة، بما فيها رسائل المنصة نفسها. عند تجاوز الحد تُرفض الرسائل حتى الساعة التالية. القيمة 0 توقف هذا الحد. إعداد على مستوى المنصة، والافتراضي 20000.',
	'set.section.introspection': 'فحص الرموز (Introspection)',
	'set.section.introspection.desc': 'الإجابة التي يتلقاها خادم الموارد عندما يسأل عن صلاحية رمز.',
	'set.k.tokens.introspection_extended_claims': 'إرجاع المطالبات الإضافية لكل خادم موارد',
	'set.k.tokens.introspection_extended_claims.desc':
		'متوقف: تحتوي الإجابة على المطالبات الأساسية فقط (active وscope وclient_id وsub وexp وما شابه) ولا يُستخدم ملف تعريف خادم الموارد ولا تعيين الهوية. مفعّل: تُضاف المطالبات التي يسمح بها ملف تعريفه.',
	'set.section.scim': 'توفير SCIM',
	'set.section.scim.desc': 'الرموز التي تستخدمها الأنظمة الخارجية لمزامنة المستخدمين عبر SCIM.',
	'set.section.scim.advanced': 'أطول مدة صلاحية مسموحة',
	'set.k.federation.scim_token_default_expiry': 'مدة صلاحية رمز SCIM الافتراضية',
	'set.k.federation.scim_token_default_expiry.desc':
		'مدة صلاحية رمز SCIM عند إنشائه دون تحديد مدة. لا تتجاوز الحد الأقصى أبدًا. لا تتغير الرموز الصادرة سابقًا.',
	'set.k.federation.scim_token_max_expiry': 'أطول مدة صلاحية لرمز SCIM',
	'set.k.federation.scim_token_max_expiry.desc':
		'لا يمكن إنشاء رمز SCIM بمدة أطول من ذلك (سنة واحدة كحد أقصى). لا تتغير الرموز الصادرة سابقًا.',
	'set.k.assurance.scim_max_ial': 'أعلى مستوى لضمان الهوية (IAL) يمكن لـ SCIM الإقرار به',
	'set.k.assurance.scim_max_ial.desc':
		'أعلى مستوى لضمان الهوية يمكن لنظام خارجي أن يقرّ به لمستخدم عبر SCIM: 1 هو IAL1 (بلا تحقق من الهوية)، و2 هو IAL2، و3 هو IAL3. يُرفض أي طلب يقرّ بمستوى أعلى ولا يغيّر شيئًا. القيمة الأولية 1، فلا يستطيع SCIM الإقرار بـ IAL2 أو IAL3 إلا بعد رفعها. لا تُلغى المستويات المسجلة سابقًا عند خفضها. ولا تشمل هذه القيمة ما يسجله المسؤولون، ولا المستوى الممنوح للحسابات التي تنشئها المؤسسة، ولا عمليات الاستيراد من CSV.',
	'set.page.enterprise': 'SAML',
	'set.page.enterprise.desc':
		'يحدد ما إذا كان هذا المستأجر يستجيب لـ SAML أصلًا، ومدة صلاحية تأكيدات SAML وطلباته، وما تبدأ به مزودات SAML الجديدة. تسجيل المزودات (IdP وSP) ما زال يتم حاليًا من صفحة SAML في واجهة الإدارة السابقة.',
	'set.section.samlService': 'خدمة SAML',
	'set.section.samlService.desc':
		'عند الإيقاف يرفض هذا المستأجر كل طلبات SAML ولا ينشر بيانات SAML الوصفية. تبقى المزودات المسجلة محفوظة.',
	'set.k.federation.saml_enabled': 'استخدام SAML',
	'set.k.federation.saml_enabled.desc':
		'أثناء الإيقاف تُرجع نقاط نهاية SAML لـ IdP وSP والبيانات الوصفية الرمز 403 (يستمر عمل فحص الصحة وواجهة الإدارة). عند إعادة التشغيل تعمل المزودات المسجلة كما كانت. قد يستغرق تطبيق التغيير نحو دقيقة.',
	'set.section.samlLifetimes': 'مدد الصلاحية',
	'set.section.samlLifetimes.desc': 'مدة بقاء تأكيدات SAML وطلباته صالحة.',
	'set.section.samlLifetimes.advanced': 'مدة صلاحية الطلب',
	'set.k.federation.saml_assertion_ttl': 'مدة صلاحية التأكيد',
	'set.k.federation.saml_assertion_ttl.desc':
		'مدة صلاحية تأكيد SAML الذي تصدره Authrim (من 60 إلى 600 ثانية). مزود الخدمة الذي له مدة خاصة يحتفظ بها. يسري التغيير على التأكيدات الصادرة بعده.',
	'set.k.federation.saml_request_ttl': 'مدة صلاحية الطلب',
	'set.k.federation.saml_request_ttl.desc':
		'مدة بقاء طلب تسجيل الدخول أو الخروج في SAML صالحًا (من 60 إلى 600 ثانية): أقدم طلب تقبله Authrim، ومدة الاحتفاظ بالطلبات المرسلة لمطابقتها مع ردودها. يسري التغيير على مدة حفظ الطلبات التي تُقدَّم بعده. ويُتحقق من عمر الطلب أيضًا بالقيمة الحالية عند استئناف تسجيل دخول جارٍ، لذا قد يؤدي تقصير القيمة إلى رفض عمليات تسجيل دخول بدأت بالفعل.',
	'set.section.samlProviderDefaults': 'القيم الافتراضية للمزودات الجديدة',
	'set.section.samlProviderDefaults.desc':
		'ما يحصل عليه مزود SAML عند إضافته أو استيراد بياناته الوصفية إذا لم يُحدَّد غير ذلك. لا تتغير المزودات الحالية.',
	'set.section.samlProviderDefaults.advanced': 'الارتباطات (Bindings)',
	'set.k.federation.saml_nameid_format': 'صيغة NameID',
	'set.k.federation.saml_nameid_format.desc':
		'صيغة NameID التي يحصل عليها المزود إذا لم تذكر بياناته الوصفية أي صيغة. المزود ذو الملف الشخصي الذي يحدد صيغته (مثل strict) يحتفظ بها. تمنح persistent كل خدمة معرّفًا خاصًا بها، مما يحمي خصوصية الأشخاص.',
	'set.k.federation.saml_nameid_format.emailAddress': 'عنوان البريد الإلكتروني',
	'set.k.federation.saml_nameid_format.persistent': 'معرّف دائم',
	'set.k.federation.saml_nameid_format.transient': 'معرّف مؤقت',
	'set.k.federation.saml_nameid_format.unspecified': 'غير محدد',
	'set.k.federation.saml_sso_binding': 'ارتباط تسجيل الدخول',
	'set.k.federation.saml_sso_binding.desc':
		'الارتباط الذي يُسجَّل به الدخول عبر مزود هوية خارجي جديد عندما تعرض بياناته الوصفية الاثنين أو لا تذكر أيًا منهما. يرسل HTTP-Redirect طلبًا موقّعًا، بينما يرسل HTTP-POST طلبًا غير موقّع.',
	'set.k.federation.saml_sso_binding.HTTP-POST': 'HTTP-POST',
	'set.k.federation.saml_sso_binding.HTTP-Redirect': 'HTTP-Redirect',
	'set.k.federation.saml_slo_binding': 'ارتباط تسجيل الخروج',
	'set.k.federation.saml_slo_binding.desc':
		'الارتباط الافتراضي لطلبات تسجيل الخروج، ويُستخدم عندما تعرض البيانات الوصفية الاثنين أو لا تذكر أيًا منهما. المزود ذو الملف الشخصي الذي يحدد ارتباطه (الملف legacy) يحتفظ به.',
	'set.k.federation.saml_slo_binding.HTTP-POST': 'HTTP-POST',
	'set.k.federation.saml_slo_binding.HTTP-Redirect': 'HTTP-Redirect',
	'set.section.samlInstitution': 'المؤسسة',
	'set.section.samlInstitution.desc':
		'المؤسسة التي يمثلها هذا المستأجر: النطاقات التي تُصدر المعرّفات تحتها، واسمها. المنصة وحدها تستطيع تغييرها، ويمكن لمسؤولي المستأجر قراءتها فقط. ما لم تُضبط، لا يتغير شيء في تأكيدات SAML ولا في بياناتها الوصفية.',
	'set.k.institution.scopes': 'النطاقات (Scopes)',
	'set.k.institution.scopes.desc':
		'أسماء نطاقات تفصل بينها فواصل، والأول هو الافتراضي (مثل example.ac.jp,med.example.ac.jp). بأحرف صغيرة، دون أحرف بدل، وبحد أقصى 20. بعد ضبطها، تحمل تأكيدات SAML القيمتين eduPersonScopedAffiliation وeduPersonPrincipalName تحت هذه النطاقات فقط: تُحذف القيمة التابعة لنطاق آخر وتُسجَّل في سجل التدقيق، وتحصل القيمة التي بلا نطاق على النطاق الافتراضي. تعرضها البيانات الوصفية (shibmd:Scope)، ويمكن تمرير النطاق الافتراضي إلى مزود خدمة بوصفه schacHomeOrganization. تجنّب تغييرها ما دام مزودو الخدمة يعتمدون على القديمة، فهم يحتفظون بالبيانات الوصفية لمدة تصل إلى يوم. لا يتأثر OIDC.',
	'set.k.institution.display_names': 'الأسماء',
	'set.k.institution.display_names.desc':
		'اسم المؤسسة بكل لغة، كنص JSON يتضمن ja وen على الأقل (مثل {"ja": "例大学", "en": "Example University"}). بعد ضبطه، تسمّي البيانات الوصفية لـ SAML المؤسسة به، ويمكن تمرير الاسم الإنجليزي إلى مزود خدمة بوصفه اسم المنظمة (o). لا يتأثر OIDC.',
	'set.k.oauth.id_token_signing_alg.RS256': 'RS256',
	'set.k.oauth.id_token_signing_alg.ES256': 'ES256',
	'set.k.oauth.id_token_signing_alg.PS256': 'PS256',
	'set.k.oauth.refresh_token_rotation.desc':
		'يتوقف الرمز المستخدم عن العمل، فلا يمكن إعادة استخدام رمز مسرّب. يُنصح بإبقاء هذا الخيار مفعّلاً.',
	'set.k.oauth.refresh_token_sliding_window_enabled': 'تمديد الصلاحية في كل مرة يُستخدم فيها',
	'set.k.oauth.refresh_token_sliding_window_enabled.desc':
		'كل استخدام لرمز التحديث يبدأ مدة صلاحيته من جديد.',
	'set.k.oauth.refresh_token_absolute_expiry_enabled': 'تحديد حدّ لا يتجاوزه التمديد',
	'set.k.oauth.refresh_token_absolute_expiry_enabled.desc':
		'يحدّ المدة منذ إصدار أول رمز. بعدها يسجّل الشخص الدخول مجدداً.',
	'set.k.oauth.refresh_token_absolute_expiry': 'الحد (من أول رمز)',
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

	'set.k.identity_mapping.oidc_default_set_id': 'مجموعة الربط الافتراضية (OIDC)',
	'set.k.identity_mapping.oidc_default_set_id.desc':
		'معرّف مجموعة الربط التي تستخدمها التطبيقات في هذا النطاق إذا لم تختر مجموعة خاصة بها. عدم التعيين يعني عدم وجود إعداد افتراضي، فلا يُطبَّق أي ربط. يمكن للمستأجر إدخال none لتجاهل الإعداد الافتراضي للمنصة أيضًا. يمكن تحديد مجموعة ربط نشطة فقط. تستخدمه التطبيقات التي لا تحدد مجموعة ربط خاصة بها في رمز الهوية وUserInfo وشاشة الموافقة، ويمكن لأي تطبيق الانسحاب بقيمة none الخاصة به. إذا تعذّر استخدام مجموعة الربط المحددة (محذوفة أو غير نشطة أو غير صالحة)، فلن تتمكن هذه التطبيقات من تسجيل الدخول حتى يُصحَّح الإعداد أو تُمسح القيمة.',

	'set.k.bulk_apply.max_tenants_per_request': 'التطبيق الجماعي: عدد المستأجرين في الطلب',
	'set.k.bulk_apply.max_tenants_per_request.desc':
		'أكبر عدد من المستأجرين يمكن أن يذكره طلب تطبيق جماعي واحد، ويُحتسب المستأجر المذكور مرتين مرة واحدة. يكلّف كل مستأجر عدة طلبات فرعية وبعض زمن التنفيذ، لذا لا يتّسع الطلب الواحد إلا لعدد محدود، وتُرسل المهام الأكبر على عدة طلبات. يُحصر بين 1 و100. إعداد على مستوى المنصة، والقيمة الافتراضية 25.',

	'set.k.bulk_apply.max_keys_per_request': 'التطبيق الجماعي: عدد الإعدادات في الطلب',
	'set.k.bulk_apply.max_keys_per_request.desc':
		'أكبر عدد من الإعدادات (المفاتيح المضبوطة أو المُزالة عبر كل الفئات) يمكن أن يحمله طلب تطبيق جماعي واحد. يُحصر بين 1 و100. إعداد على مستوى المنصة، والقيمة الافتراضية 20.',

	'set.k.tenant_capabilities.webhooks': 'السماح للمستأجرين باستخدام Webhooks',
	'set.k.tenant_capabilities.webhooks.desc':
		'عند الإيقاف: لا يستطيع المستأجرون إدارة Webhooks عبر Admin API، ولا يُسلَّم أي Webhook للمستأجرين. تُهمَل الأحداث التي تقع أثناء الإيقاف ولا تُسلَّم لاحقًا. تُسقَط أحداث Webhook الحسابات المستحقة في قائمة الانتظار عند معالجتها وتُسجَّل في سجل التدقيق (webhook.outbox.dropped)، أما الأحداث التي ما زالت منتظرة لحظة إعادة التشغيل فتُسلَّم. مسؤولو المنصة مستثنون في Admin API. يسري التغيير خلال دقيقة تقريبًا. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.dynamic_client_registration':
		'السماح للمستأجرين بالتسجيل الديناميكي للعملاء',
	'set.k.tenant_capabilities.dynamic_client_registration.desc':
		'عند الإيقاف: يُرفض التسجيل العام (POST /register) ونقاط إعداد العميل ورموز الوصول الأولية، ويتوقف الاكتشاف عن الإعلان عن نقطة التسجيل. ولا يستطيع المستأجرون أيضًا تغيير إعدادات التسجيل الديناميكي للعملاء. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.external_plugins': 'السماح للمستأجرين باستخدام الإضافات الخارجية',
	'set.k.tenant_capabilities.external_plugins.desc':
		'عند الإيقاف: لا يُنفَّذ أي شيء من الإضافات الخارجية للمستأجرين، ولا يستطيع أحد تفعيل إضافة خارجية (ولا مسؤولو المنصة). لا يستطيع المستأجرون تغيير بيانات الاعتماد أو إعدادات الإضافات؛ ويستطيع مسؤولو المنصة إدارتها لكن لا يعمل شيء للمستأجرين. الإضافات المدمجة (إشعارات البريد وCAPTCHA وTOTP) لا تتأثر. يُنفَّذ الإيقاف مستأجرًا بعد مستأجر عبر مهمة دورية، وقد يستغرق عدة دقائق أو أكثر. لا تستعيد استعادة النسخ الاحتياطي للمستأجر تثبيتات الإضافات الخارجية. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.bulk_jobs': 'السماح للمستأجرين بتشغيل المهام الجماعية',
	'set.k.tenant_capabilities.bulk_jobs.desc':
		'عند الإيقاف: لا يستطيع المستأجرون ولا مسؤولو المنصة إنشاء مهام جماعية (استيراد المستخدمين، التحديث الجماعي، إنشاء التقارير، أعضاء المؤسسات بالجملة). لا تبدأ المهام المنتظرة بل تنتهي كمحظورة ويجب إنشاؤها من جديد بعد إعادة التشغيل. تبقى المهام الحالية ونتائجها قابلة للقراءة. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.admin_sent_email':
		'السماح لمسؤولي المستأجرين بإرسال البريد الإلكتروني',
	'set.k.tenant_capabilities.admin_sent_email.desc':
		'عند الإيقاف: لا يستطيع مسؤول المستأجر أن يطلب من النظام إرسال بريد إلكتروني: إجراء إرسال بريد إلكتروني لمستخدم، ودعوات التسجيل الموجّهة إلى عنوان بريد إلكتروني، ودعوات المسؤولين المرسلة بالبريد (الإنشاء وإعادة الإرسال)، والبريد التجريبي لإضافة مزوّد البريد. دعوات المسؤولين التي يُسلَّم رمزها في استجابة واجهة البرمجة (code_delivery response) لا ترسل بريدًا ولا تتأثر، وكذلك رسائل مسارات المستخدم النهائي (رموز تسجيل الدخول، التحقق). مسؤولو المنصة مستثنون في واجهة الإدارة. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.machine_credentials':
		'السماح لمسؤولي المستأجرين بإصدار بيانات اعتماد الأجهزة',
	'set.k.tenant_capabilities.machine_credentials.desc':
		'عند الإيقاف: لا يستطيع مسؤولو المستأجرين إصدار بيانات اعتماد جديدة طويلة الأمد للأجهزة: إنشاء أو تدوير أو إعادة تفعيل كيانات الوصول الآلي وبيانات اعتمادها (بما في ذلك تغيير الأذونات أو المستأجرين أو الصلاحية)، وإنشاء رموز SCIM، وإنشاء مفاتيح Check API أو تدويرها. يبقى ممكنًا العرض والإلغاء والتعطيل والحذف. تظل بيانات الاعتماد الصادرة سارية حتى تُلغى أو تنتهي. مسؤولو المنصة مستثنون في واجهة الإدارة. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.email_provider_config':
		'السماح لمسؤولي المستأجرين بتغيير مزوّد البريد الإلكتروني',
	'set.k.tenant_capabilities.email_provider_config.desc':
		'عند الإيقاف: لا يستطيع مسؤولو المستأجرين تغيير المزوّد أو المرسِل الذي يمر عبره بريد المستأجر: إعدادات بريد المستأجر (ترتيب المزوّدين) وإعداد إضافات الإشعار المدمجة للبريد وإعادة ضبطها وتفعيلها. يبقى ممكنًا العرض وتعطيل إضافة الإشعار. مسؤولو المنصة مستثنون في واجهة الإدارة. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.directory_connectors':
		'السماح لمسؤولي المستأجرين بإعداد موصّلات الدليل',
	'set.k.tenant_capabilities.directory_connectors.desc':
		'عند الإيقاف: لا يستطيع مسؤولو المستأجرين جعل المنصة تتصل بنقطة نهاية موصّل دليل اختاروها: حفظ إعدادات موصّل الدليل (باستثناء حفظ يقتصر على إزالة الموصّلات أو إيقاف تسجيل الدخول عبر الدليل أو إبقاء الموصّلات المخزّنة كما هي)، وإصدار أسرار الموصّل وتدويرها، وفحص سلامة الموصّل. يبقى العرض ممكنًا. تستمر الموصّلات المُعدّة سابقًا في العمل. مسؤولو المنصة مستثنون في واجهة الإدارة. لا تستعيد استعادة نسخة المستأجر الاحتياطية إعدادات الموصّلات أثناء الإيقاف إلا إذا طلبها مسؤول المنصة. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.external_identity_providers':
		'السماح لمسؤولي المستأجرين بإعداد مزوّدي الهوية الخارجيين',
	'set.k.tenant_capabilities.external_identity_providers.desc':
		'عند الإيقاف: لا يستطيع مسؤولو المستأجرين إضافة مزوّدي هوية خارجيين أو تغييرهم (الإنشاء والتحديث واكتشاف OIDC والتسجيل الديناميكي للعميل لدى المزوّد). يبقى العرض والحذف ممكنين. يستمر المزوّدون المُعدّون سابقًا في العمل. مسؤولو المنصة مستثنون في واجهة الإدارة. لا تستعيد استعادة نسخة المستأجر الاحتياطية مزوّدي الهوية الخارجيين أثناء الإيقاف إلا إذا طلبها مسؤول المنصة. الإعداد الافتراضي: مفعّل.',

	'set.k.tenant_capabilities.saml_metadata_url':
		'السماح لمسؤولي المستأجرين بجلب بيانات SAML الوصفية من عنوان URL',
	'set.k.tenant_capabilities.saml_metadata_url.desc':
		'عند الإيقاف: لا يستطيع مسؤولو المستأجرين جعل المنصة تجلب بيانات SAML الوصفية من عنوان URL اختاروه أو تخزين عنوان جديد لجلبه لاحقًا: معاينة البيانات الوصفية واستيرادها وتحديثها ومعاينة الشهادة باستخدام عنوان URL، وحفظ مزوّد SAML أو مصدر اتحاد بعنوان بيانات وصفية جديد أو معدّل. يبقى ممكنًا لصق XML للبيانات الوصفية والإبقاء على عنوان مخزّن أو مسحه والعرض والحذف. تستمر العناوين المخزّنة سابقًا في التحديث تلقائيًا. مسؤولو المنصة مستثنون في واجهة الإدارة. لا تستعيد استعادة نسخة المستأجر الاحتياطية المزوّدين والمصادر التي تحمل عنوان بيانات وصفية أثناء الإيقاف إلا إذا طلبها مسؤول المنصة. الإعداد الافتراضي: مفعّل.',

	'set.k.identity_mapping.reference_scan_tenant_limit': 'بحث استخدام مجموعة الربط: المستأجرون',
	'set.k.identity_mapping.reference_scan_tenant_limit.desc':
		'أكبر عدد من المستأجرين تُقرأ تطبيقاتهم عند البحث عن أماكن استخدام مجموعة ربط تملكها المنصة. كل مستأجر قراءة لقاعدة بيانات؛ وإذا زاد العدد عن ذلك يُعدّ الباقي غير مفحوص ويُرفض حذف المجموعة أو إيقافها. بين 1 و1000. إعداد للمنصة؛ القيمة الافتراضية 200.',

	'set.k.identity_mapping.reference_scan_row_limit': 'بحث استخدام مجموعة الربط: الصفوف لكل موضع',
	'set.k.identity_mapping.reference_scan_row_limit.desc':
		'أكبر عدد من الصفوف يُقرأ من موضع واحد (إعدادات المستأجرين الافتراضية، أو تطبيقات مستأجر واحد، أو موفّري SAML لمستأجر واحد) عند البحث عن أماكن استخدام مجموعة ربط. يُقطع الموضع الأكبر ويُعطى العدد كحدّ أدنى. بين 10 و5000. إعداد للمنصة؛ القيمة الافتراضية 500.',

	'set.k.identity_mapping.reference_scan_concurrency': 'بحث استخدام مجموعة الربط: التزامن',
	'set.k.identity_mapping.reference_scan_concurrency.desc':
		'عدد المستأجرين الذين يُقرؤون في الوقت نفسه عند البحث عن أماكن استخدام مجموعة ربط تملكها المنصة. بين 1 و16. إعداد للمنصة؛ القيمة الافتراضية 8.',

	'set.k.identity_mapping.reference_display_limit': 'استخدام مجموعة الربط: المراجع المعروضة',
	'set.k.identity_mapping.reference_display_limit.desc':
		'عدد المراجع التي يسردها جواب الاستخدام ورفض الحذف؛ أما العدد فيبقى دائماً الإجمالي. بين 1 و100. إعداد للمنصة؛ القيمة الافتراضية 20.',

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
	'settings.inDevelopment': 'قيد التطوير: لا يؤثر تغييره بعد',
	'settings.locked.tenant': 'قيمة ثابتة بإعدادات المستأجر',
	'settings.badge.locked': 'مقفل',
	'settings.badge.here': 'متجاوز',
	'settings.badge.inDevelopment': 'قيد التطوير',
	'settings.notice.idTokenAlgorithm.title': 'يخالف هذا مواصفة OpenID Connect Discovery',
	'settings.notice.idTokenAlgorithm.body':
		'تُوقَّع كل رموز الهوية بخوارزمية غير RS256 ولا يمكن للتطبيقات اختيار RS256، لذا لم يعد مستند الاكتشاف يعرض RS256 الذي تشترطه مواصفة OpenID Connect Discovery. يظل الاكتشاف نفسه يعمل.',
	'settings.notice.fapi.title': 'تنطبق متطلبات FAPI 2.0',
	'settings.notice.fapi.body':
		'تُرفض الطلبات التي لا يسمح بها FAPI 2.0، مثل طلبات التفويض بدون PAR، لذا قد تتوقف التطبيقات التي لا تدعم FAPI عن العمل. يظل الاكتشاف يعمل وفق المواصفة.',
	'settings.notice.exchangeCeilings.title': 'ستُرفض عملية تبادل الرموز لبعض التطبيقات',
	'settings.notice.exchangeCeilings.body':
		'تبادل الرموز مفعّل لكن التفويض غير مسموح، لذا تُرفض التطبيقات في وضع التفويض (الافتراضي للتطبيقات الجديدة). فعّل «السماح بالتفويض» لتتمكن من استخدامه.',
	'settings.notice.samlDisabled.title': 'ستتوقف التطبيقات ومزودات الهوية الخارجية التي تستخدم SAML',
	'settings.notice.samlDisabled.body':
		'عند إيقاف SAML تفشل التطبيقات التي تسجّل الدخول عبر SAML (مزودات الخدمة) وتسجيل الدخول عبر مزودات هوية SAML الخارجية. تبقى المزودات المسجلة محفوظة، وإعادة التشغيل تعيدها.',
	'settings.notice.samlPostBinding.title': 'يرسل HTTP-POST طلب تسجيل الدخول بلا توقيع',
	'settings.notice.samlPostBinding.body':
		'طلب تسجيل الدخول المرسل إلى مزود هوية جديد عبر HTTP-POST لا يحمل توقيعًا. الافتراضي هو HTTP-Redirect الذي يمكن توقيعه. اختر POST فقط إذا كان مزود الهوية لا يقبل غيره.',
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
	'persona.viewer.desc': 'يرى المستخدمين والتطبيقات والإعدادات، ولا يغيّر شيئاً.',
	// The platform's Default methods and the profile switches (platform profile pages).
	'set.k.authentication-methods.passkey.signup_enabled': 'مفتاح المرور: التسجيل',
	'set.k.authentication-methods.passkey.login_enabled': 'مفتاح المرور: تسجيل الدخول',
	'set.k.authentication-methods.passkey.reauth_enabled': 'مفتاح المرور: إعادة المصادقة',
	'set.k.authentication-methods.passkey.account_link_enabled': 'مفتاح المرور: ربط الحساب',
	'set.k.authentication-methods.email_otp.signup_enabled': 'رمز لمرة واحدة عبر البريد: التسجيل',
	'set.k.authentication-methods.email_otp.login_enabled': 'رمز لمرة واحدة عبر البريد: تسجيل الدخول',
	'set.k.authentication-methods.email_otp.reauth_enabled':
		'رمز لمرة واحدة عبر البريد: إعادة المصادقة',
	'set.k.authentication-methods.email_otp.account_link_enabled':
		'رمز لمرة واحدة عبر البريد: ربط الحساب',
	'set.k.authentication-methods.totp.signup_enabled': 'تطبيق المصادقة (TOTP): التسجيل',
	'set.k.authentication-methods.totp.login_enabled': 'تطبيق المصادقة (TOTP): تسجيل الدخول',
	'set.k.authentication-methods.totp.reauth_enabled': 'تطبيق المصادقة (TOTP): إعادة المصادقة',
	'set.k.authentication-methods.totp.account_link_enabled': 'تطبيق المصادقة (TOTP): ربط الحساب',
	'set.k.authentication-methods.did.login_enabled': 'DID: تسجيل الدخول',
	'set.k.authentication-methods.directory_password.enabled': 'Directory Password: تسجيل الدخول',
	'set.k.authentication-methods.guest.login_enabled': 'السماح بتسجيل دخول الضيف',
	'set.k.authentication-methods.passkey.guest_upgrade_enabled': 'ترقية حساب الضيف بمفتاح مرور',
	'set.k.authentication-methods.email_otp.guest_upgrade_enabled':
		'ترقية حساب الضيف برمز البريد الإلكتروني',
	'set.k.authentication-methods.totp.preset': 'الإعداد المسبق لتطبيق المصادقة',
	'set.k.authentication-methods.totp.preset.compatible': 'متوافق',
	'set.k.authentication-methods.totp.preset.strong': 'قوي',
	'set.k.authentication-methods.totp.default_acr': 'قيمة ACR عند تسجيل الدخول بتطبيق المصادقة',
	'set.k.profiles.method.tenant_change_allowed': 'يمكن للمستأجرين تغيير ملفات طرق المنصة',
	'set.k.profiles.method.tenant_create_allowed': 'يمكن للمستأجرين إنشاء ملفات طرق خاصة بهم',
	'set.k.profiles.method.default_locked': 'قفل طرق Default (لا تُطبَّق قيم المستأجرين)',
	'set.k.profiles.session.tenant_change_allowed': 'يمكن للمستأجرين تغيير ملفات جلسات المنصة',
	'set.k.profiles.session.tenant_create_allowed': 'يمكن للمستأجرين إنشاء ملفات جلسات خاصة بهم',
	'set.k.profiles.session.default_locked': 'قفل قواعد جلسات Default (لا تُطبَّق قيم المستأجرين)'
};
