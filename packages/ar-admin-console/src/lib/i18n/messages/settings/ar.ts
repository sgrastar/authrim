import type { jaSettings } from './ja';

export const arSettings: Record<keyof typeof jaSettings, string> = {
	'set.page.stayingSignedIn': 'البقاء مسجلاً للدخول',
	'set.page.stayingSignedIn.desc':
		'المدة التي يبقى فيها الأشخاص مسجلين للدخول بعد تسجيل دخولهم، والمدة التي تحتفظ فيها تطبيقاتهم بهذا الدخول.',
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
	'set.page.appDefaults': 'الإعدادات الافتراضية للتطبيقات',
	'set.page.appDefaults.desc':
		'قواعد طلبات التفويض والرموز التي تنطبق على كل تطبيقات المستأجر. يمكن لإعدادات التطبيق إضافة متطلب أمني لكن لا يمكنها إلغاؤه.',
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
		'تمنع إساءة استخدام رسائل البريد الإلكتروني الخاصة بتسجيل الدخول والتسجيل.',
	'set.section.emailSending': 'حد إرسال البريد الإلكتروني',
	'set.section.emailSending.desc':
		'يحدّ من عدد مرات إرسال رسائل مثل رموز تسجيل الدخول إلى المستلم نفسه تباعًا، حتى لا تُستخدم في إرسال رسائل مزعجة.',
	'set.k.rate_limit.email_max_requests': 'عدد مرات الإرسال المسموح في الفترة',
	'set.k.rate_limit.email_max_requests.desc':
		'عدد رموز تسجيل الدخول والتسجيل وإعادة المصادقة وترحيل الدليل التي يمكن إرسالها إلى عنوان البريد الإلكتروني نفسه (أو المستخدم نفسه). لرموز اكتشاف الحساب حدّ مستقل.',
	'set.k.rate_limit.email_window': 'الفترة التي يُحتسب فيها الإرسال',
	'set.k.rate_limit.email_window.desc':
		'الفترة التي يُحتسب فيها العدد أعلاه (من 5 إلى 60 دقيقة). بعد انقضائها يُسمح بالإرسال من جديد.',
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
	'set.page.enterprise': 'الدخول الموحد للمؤسسات (SAML)',
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
	'persona.viewer.desc': 'يرى المستخدمين والتطبيقات والإعدادات، ولا يغيّر شيئاً.'
};
