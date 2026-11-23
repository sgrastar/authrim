import type { jaIpAllowlist } from './ja';

export const arIpAllowlist: Record<keyof typeof jaIpAllowlist, string> = {
	'ip.page.desc':
		'قيّد عناوين IP التي يمكنها الوصول إلى وحدة تحكم الإدارة وواجهة Admin API. ينطبق ذلك على مسؤولي هذا المستأجر ولا يؤثر في تسجيل دخول المستخدمين النهائيين.',
	'ip.add': 'إضافة IP',
	'ip.check': 'فحص عنوان IP',

	'ip.status.open.title': 'لا يوجد تقييد لعناوين IP',
	'ip.status.open.body':
		'يمكن للمسؤولين تسجيل الدخول من أي عنوان IP. بعد إضافة إدخال مفعّل، لن يتمكن من ذلك إلا من العناوين الواقعة في نطاقه.',
	'ip.status.active.title': 'تقييد عناوين IP مفعّل',
	'ip.status.active.body':
		'لا يصل إلى وحدة تحكم الإدارة وواجهة Admin API إلا العناوين الواقعة في نطاق إدخال مفعّل.',
	'ip.you.label': 'عنوان IP الخاص بك',
	'ip.you.allowed': 'مسموح',
	'ip.you.blocked': 'غير مسموح',
	'ip.you.unknown': 'تعذّر التحديد',
	'ip.you.none': 'تعذّرت قراءة عنوان IP الخاص بك.',
	'ip.you.ipv6': 'هذا عنوان IPv6. لا يسمح به نطاق IPv4، وتضيف هذه الصفحة نطاقات IPv4 فقط.',

	'ip.list.title': 'عناوين IP المدرجة',
	'ip.col.range': 'عنوان IP أو نطاق',
	'ip.col.size': 'يشمل',
	'ip.col.status': 'الحالة',
	'ip.col.created': 'تاريخ الإضافة',
	'ip.col.actions': 'الإجراءات',
	'ip.col.actionsFor': 'إجراءات {range}',
	'ip.size.single': 'عنوان واحد',
	'ip.size.range': '{count} عنوان',
	'ip.size.ipv6': 'IPv6',
	'ip.on': 'مفعّل',
	'ip.off': 'متوقف',
	'ip.mine': 'يشمل عنوان IP الخاص بك',
	'ip.empty.title': 'لا يوجد شيء مدرج بعد',
	'ip.empty.body': 'أضف عنوان IP أو نطاقًا لتفعيل تقييد عناوين IP.',
	'ip.noAccess': 'ليس لديك صلاحية الوصول إلى تقييد عناوين IP.',
	'ip.loadFailed': 'تعذّر تحميل تقييد عناوين IP.',

	'ip.action.edit': 'تعديل',
	'ip.action.enable': 'تفعيل',
	'ip.action.disable': 'إيقاف',
	'ip.action.delete': 'حذف',

	'ip.new.title': 'إضافة IP',
	'ip.new.submit': 'إضافة',
	'ip.edit.title': 'تعديل IP',
	'ip.edit.submit': 'حفظ',
	'ip.field.range': 'عنوان IP أو نطاق',
	'ip.field.rangeHint':
		'أدخل عنوان IPv4 واحدًا (203.0.113.5) أو نطاقًا بصيغة CIDR (203.0.113.0/24).',
	'ip.field.rangeIpv6':
		'لا يمكن تغيير إدخال IPv6 في هذه الصفحة. يمكنك تغيير وصفه أو إيقافه أو حذفه.',
	'ip.field.description': 'الوصف (اختياري)',
	'ip.field.descriptionPlaceholder': 'مثال: شبكة المقر الرئيسي',
	'ip.useMine': 'استخدام عنوان IP الخاص بي',
	'ip.preview.single': 'يشمل هذا العنوان الواحد.',
	'ip.preview.range': 'يشمل من {first} إلى {last} ({count} عنوان).',
	'ip.preview.all': 'يشمل كل عناوين IPv4.',
	'ip.preview.normalized': 'سيُحفظ بصيغة {range}.',
	'ip.preview.mine': 'يشمل عنوان IP الخاص بك.',
	'ip.preview.notMine': 'لا يشمل عنوان IP الخاص بك.',

	'ip.err.empty': 'أدخل عنوان IP أو نطاقًا.',
	'ip.err.address': 'هذا ليس عنوان IPv4. أدخل أربعة أرقام من 0 إلى 255 تفصل بينها نقاط.',
	'ip.err.prefix': 'طول النطاق من 0 إلى 32 (مثل 24/).',
	'ip.err.ipv6': 'لا يمكن إضافة IPv6 في هذه الصفحة. أدخل عنوان IPv4.',
	'ip.err.duplicate': 'هذا النطاق مدرج بالفعل.',
	'ip.err.invalid': 'لم يقبل الخادم هذه القيمة. راجع ما أدخلته.',
	'ip.err.forbidden': 'ليس لديك صلاحية لتنفيذ ذلك.',
	'ip.err.notFound': 'سبق حذف هذا الإدخال. سيُعاد تحميل القائمة.',
	'ip.err.generic': 'تعذّر الحفظ. حاول مرة أخرى.',

	'ip.lock.title': 'ستُحظر من الدخول',
	'ip.lock.body':
		'بعد هذا التغيير لن يقع عنوان IP الخاص بك ({ip}) في أي نطاق مسموح. بعد الحفظ لن تتمكن من الوصول إلى وحدة تحكم الإدارة من هذا العنوان.',
	'ip.lock.bodyNoIp':
		'بعد هذا التغيير قد لا يقع عنوان IP الخاص بك في أي نطاق مسموح. بعد الحفظ قد لا تتمكن من الوصول إلى وحدة تحكم الإدارة.',
	'ip.lock.ipv6': 'لا يمكن لنطاق IPv4 أن يسمح بعنوان IPv6.',
	'ip.lock.confirm': 'المتابعة على أي حال',

	'ip.delete.title': 'حذف {range}؟',
	'ip.delete.body': 'سيُحذف هذا الإدخال ولا يمكن التراجع عن ذلك.',
	'ip.delete.last':
		'لن يبقى أي إدخال مفعّل، لذا سيُرفع تقييد عناوين IP ويمكن لأي عنوان IP تسجيل الدخول.',
	'ip.delete.confirm': 'حذف',

	'ip.check.title': 'فحص عنوان IP',
	'ip.check.desc':
		'تحقق مما إذا كان عنوان IP يستطيع الوصول إلى وحدة تحكم الإدارة وفق الإدخالات المفعّلة.',
	'ip.check.field': 'عنوان IP',
	'ip.check.submit': 'فحص',
	'ip.check.allowed': '{ip} مسموح.',
	'ip.check.blocked': '{ip} غير مسموح.',
	'ip.check.open': 'لا يوجد تقييد لعناوين IP، لذا فكل عنوان IP مسموح.',
	'ip.check.invalid': 'أدخل عنوان IPv4 واحدًا.',

	'ip.toast.added': 'تمت إضافة IP.',
	'ip.toast.saved': 'تم حفظ التغييرات.',
	'ip.toast.enabled': 'تم التفعيل.',
	'ip.toast.disabled': 'تم الإيقاف.',
	'ip.toast.deleted': 'تم الحذف.'
};
