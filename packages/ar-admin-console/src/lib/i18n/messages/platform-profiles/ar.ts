import type { jaPlatformProfiles } from './ja';

export const arPlatformProfiles: { [K in keyof typeof jaPlatformProfiles]: string } = {
	'pp.title.method': 'ملفات طرق تسجيل الدخول للمنصة',
	'pp.title.session': 'ملفات الجلسات للمنصة',
	'pp.desc.method':
		'ملفات طرق تسجيل الدخول التي يمكن لكل مستأجر استخدامها، وDefault المنصة الذي يقع تحت Default كل مستأجر.',
	'pp.desc.session':
		'ملفات الجلسات التي يمكن لكل مستأجر استخدامها، وDefault المنصة الذي يقع تحت Default كل مستأجر.',
	'pp.tab.profiles': 'الملفات',
	'pp.tab.default': 'Default والأذونات',
	'pp.list.name': 'اسم الملف',
	'pp.list.overriding': 'نسخ المستأجرين',
	'pp.list.overridingCount': '{count} مستأجرين',
	'pp.list.updated': 'آخر تحديث',
	'pp.list.actions': 'إجراءات {name}',
	'pp.list.open': 'فتح {name}',
	'pp.list.create': 'إنشاء ملف',
	'pp.list.empty': 'لا توجد ملفات للمنصة بعد',
	'pp.list.lock': 'قفل',
	'pp.list.unlock': 'إلغاء القفل',
	'pp.list.locked': 'تم القفل. لم تعد نسخ المستأجرين مطبَّقة (تبقى محفوظة).',
	'pp.list.unlocked': 'تم إلغاء القفل. تُطبَّق نسخ المستأجرين مجددًا.',
	'pp.list.delete': 'حذف',
	'pp.list.deleteTitle': 'هل تريد حذف {name}؟',
	'pp.list.deleteBody':
		'لن يكون متاحًا لأي مستأجر بعد ذلك. لا يمكن حذفه ما دام مسار خدمة لمستأجر يستخدمه. وتتوقف نسخ المستأجرين عن التطبيق أيضًا.',
	'pp.list.deleteSuccess': 'تم الحذف',
	'pp.list.inUse':
		'يستخدمه مسار خدمة لمستأجر، لذا لا يمكن حذفه. اختر ملفًا آخر في ذلك المسار أولاً.',
	'pp.list.checkIncomplete': 'تعذّر فحص جميع المستأجرين، لذا لم يُحذف. حاول مرة أخرى.',
	'pp.list.deleting': 'جارٍ الحذف',
	'pp.list.failed': 'فشل الإجراء',
	'pp.page.new': 'ملف جديد للمنصة',
	'pp.page.back': 'ملفات المنصة',
	'pp.page.name': 'الاسم',
	'pp.page.nameHint': 'يراه المستأجرون بهذا الاسم أيضًا.',
	'pp.page.nameRequired': 'أدخل اسمًا',
	'pp.page.nameTaken': 'يوجد ملف للمنصة بهذا الاسم بالفعل',
	'pp.page.limitReached': 'وصلت المنصة إلى الحد الأقصى لعدد الملفات. احذف ملفًا لم يعد مستخدمًا.',
	'pp.page.saved': 'تم حفظ الملف',
	'pp.page.saveFailed': 'تعذّر الحفظ',
	'pp.page.conflict': 'قام شخص آخر بتغييره أولاً. أعد التحميل وحاول مرة أخرى.',
	'pp.page.notFound': 'لم يتم العثور على هذا الملف',
	'pp.page.noAccess': 'لا يُسمح لك برؤية ملفات المنصة',
	'pp.page.loadFailed': 'تعذّر التحميل',
	'pp.page.overriding':
		'يحتفظ {count} من المستأجرين بنسخة من هذا الملف. لا يغيّر الحفظ نسخهم (يرى كل منهم «تحديث من المنصة»).',
	'pp.page.lockedNote': 'مقفل: لا تُطبَّق نسخ المستأجرين، ولا يمكن للمستأجرين تغييره.',
	'pp.page.deletingNote': 'جارٍ حذفه، لذا لا يمكن تغييره.',
	'pp.default.method': 'طرق Default للمنصة',
	'pp.default.method.desc':
		'تُستخدم حيث لا يحدد المستأجر شيئًا. أثناء القفل، أو عندما لا يُسمح للمستأجرين بتغيير الملفات، تُستخدم بدلاً من قيم المستأجر.',
	'pp.default.session': 'قواعد جلسات Default للمنصة',
	'pp.switches': 'ما يُسمح للمستأجرين به',
	'pp.switches.desc':
		'ما إذا كان يُسمح للمستأجرين بتغيير ملفات المنصة وإضافة ملفاتهم الخاصة وتغيير Default الخاص بهم. يسري الإيقاف على جميع المستأجرين في آنٍ واحد.'
};
