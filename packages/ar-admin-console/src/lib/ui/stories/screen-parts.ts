/**
 * Storybook demo data for the screen builder: a sample Identity Schema (with choices labelled in
 * every console locale) and the settings a demo part starts with. Not used by the app: the
 * console's screen pages read the tenant's schema (`pages/customization/screens`).
 */
import type {
	PartOption,
	PartSettings,
	SchemaField
} from '#lib/pages/customization/screens/screen-model.js';
import { localized } from './sample';

type Copy = readonly [string, string, string, string];

interface DemoField {
	key: string;
	type: SchemaField['type'];
	choices?: readonly { value: string; label: Copy }[];
}

/** Demo Identity Schema: attribute keys, their types, and the allowed values where fixed. */
const DEMO_FIELDS: readonly DemoField[] = [
	{ key: 'email', type: 'String' },
	{ key: 'name', type: 'String' },
	{ key: 'given_name', type: 'String' },
	{ key: 'family_name', type: 'String' },
	{ key: 'preferred_username', type: 'String' },
	{ key: 'phone_number', type: 'String' },
	{ key: 'birthdate', type: 'Date' },
	{ key: 'birth_year', type: 'Number' },
	{
		key: 'country',
		type: 'Enum',
		choices: [
			{ value: 'jp', label: ['日本', 'Japan', 'Japan', 'اليابان'] },
			{
				value: 'us',
				label: ['アメリカ合衆国', 'United States', 'Vereinigte Staaten', 'الولايات المتحدة']
			},
			{ value: 'de', label: ['ドイツ', 'Germany', 'Deutschland', 'ألمانيا'] },
			{ value: 'fr', label: ['フランス', 'France', 'Frankreich', 'فرنسا'] }
		]
	},
	{
		key: 'gender',
		type: 'Enum',
		choices: [
			{ value: 'female', label: ['女性', 'Female', 'Weiblich', 'أنثى'] },
			{ value: 'male', label: ['男性', 'Male', 'Männlich', 'ذكر'] },
			{ value: 'other', label: ['その他', 'Other', 'Divers', 'آخر'] },
			{
				value: 'unspecified',
				label: ['回答しない', 'Prefer not to say', 'Keine Angabe', 'أفضل عدم الإجابة']
			}
		]
	},
	{ key: 'news_opt_in', type: 'Boolean' },
	{ key: 'terms_accepted', type: 'Boolean' }
];

/** The demo schema in the locale chosen in the Storybook toolbar. */
export function demoSchemaFields(): SchemaField[] {
	return DEMO_FIELDS.map((field) => ({
		key: field.key,
		type: field.type,
		...(field.choices
			? {
					choices: field.choices.map((choice) => ({
						value: choice.value,
						label: localized(choice.label)
					}))
				}
			: {})
	}));
}

/** The allowed values of a demo attribute, labelled in the current language. */
export const schemaChoices = (key: string): PartOption[] =>
	(DEMO_FIELDS.find((field) => field.key === key)?.choices ?? []).map((choice) => ({
		value: choice.value,
		label: localized(choice.label)
	}));

/** Settings a demo part starts with: what it most likely stores, and a few sample options. */
export function kindDefaults(kind: string): Partial<PartSettings> {
	if (kind === 'checkbox') return { field: 'news_opt_in' };
	if (kind === 'select' || kind === 'radio') {
		// Linked: the schema's values. The own list is used once unlinked (a question kept
		// on this screen only, such as how people heard of the service).
		return {
			field: kind === 'radio' ? 'gender' : 'country',
			options: [
				{
					value: 'web',
					label: localized(['Web 検索', 'Web search', 'Websuche', 'البحث على الويب'])
				},
				{ value: 'friend', label: localized(['知人の紹介', 'A friend', 'Empfehlung', 'صديق']) },
				{ value: 'event', label: localized(['イベント', 'An event', 'Veranstaltung', 'فعالية']) }
			]
		};
	}
	return {};
}
