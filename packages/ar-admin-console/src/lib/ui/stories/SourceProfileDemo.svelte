<script lang="ts">
	import Card from '../patterns/Card.svelte';
	import EditableTable, { type EditColumn } from '../patterns/EditableTable.svelte';
	import MappingEditor from '../patterns/MappingEditor.svelte';
	import type { Mapping, MappingField, MappingType } from '../patterns/mapping-model';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { localized } from './sample';

	/**
	 * Storybook demo: an inbound source (a SAML IdP). Its attributes are defined in a table
	 * edited in place; below, how they fill Authrim's attributes. The mapping reads the
	 * table, so a new attribute can be mapped straight away.
	 * TODO(api): source profiles and mapping versions of the field-mapping API.
	 */
	interface Attribute extends Record<string, unknown> {
		path: string;
		label: string;
		type: MappingType;
		multiplicity: 'single' | 'multi';
		nullable: boolean;
		classification: 'pii' | 'internal' | 'public';
		required: boolean;
	}
	interface Profile {
		attributes: Attribute[];
		mappings: Mapping[];
	}

	const attr = (
		path: string,
		label: string,
		type: MappingType,
		required = false,
		classification: Attribute['classification'] = 'internal'
	): Attribute => ({
		path,
		label,
		type,
		multiplicity: type.endsWith('[]') ? 'multi' : 'single',
		nullable: !required,
		classification,
		required
	});

	const profile = new Draft<Profile>({
		attributes: [
			attr('mail', 'Email', 'string', true, 'pii'),
			attr('givenName', 'Given name', 'string', false, 'pii'),
			attr('sn', 'Surname', 'string', false, 'pii'),
			attr('memberOf', 'Groups', 'string[]'),
			attr('accountEnabled', 'Enabled', 'string')
		],
		mappings: [
			{
				id: 'm1',
				target: 'email',
				sources: ['mail'],
				steps: [
					{ id: 'st0', transform: 'trim', params: {} },
					{ id: 'st1', transform: 'case', params: { mode: 'lower' } }
				]
			},
			{ id: 'm2', target: 'department', sources: ['memberOf'], steps: [] },
			{
				id: 'm3',
				target: 'name',
				sources: ['givenName', 'sn'],
				steps: [{ id: 'st2', transform: 'concat', params: { delimiter: ' ' } }]
			}
		]
	});

	const targets: MappingField[] = [
		{ key: 'email', label: 'Email', type: 'string', required: true },
		{ key: 'email_verified', label: 'Email verified', type: 'boolean' },
		{ key: 'name', label: 'Name', type: 'string' },
		{ key: 'given_name', label: 'Given name', type: 'string' },
		{ key: 'family_name', label: 'Family name', type: 'string' },
		{ key: 'department', label: 'Department', type: 'string' },
		{ key: 'groups', label: 'Groups', type: 'string[]' },
		{ key: 'locale', label: 'Locale', type: 'string' },
		{ key: 'enabled', label: 'Enabled', type: 'boolean', required: true }
	];

	/** What the IdP sent in a recent sign-in, for the preview of each transform. */
	const EXAMPLES: Record<string, string | string[]> = {
		mail: 'John.Smith@Example.com',
		givenName: 'John',
		sn: 'Smith',
		memberOf: ['sales', 'admins'],
		accountEnabled: 'TRUE'
	};

	const c = (copy: readonly [string, string, string, string]) => localized(copy);
	const columns = $derived<EditColumn[]>([
		{
			key: 'path',
			label: c(['パス', 'Path', 'Pfad', 'المسار']),
			kind: 'text',
			mono: true,
			required: true,
			unique: true,
			width: '11rem'
		},
		{
			key: 'label',
			label: c(['表示名', 'Label', 'Bezeichnung', 'التسمية']),
			kind: 'text',
			width: '10rem'
		},
		{
			key: 'type',
			label: c(['型', 'Type', 'Typ', 'النوع']),
			kind: 'select',
			options: (['string', 'string[]', 'number', 'boolean', 'date'] as const).map((v) => ({
				value: v,
				label: v
			}))
		},
		{
			key: 'multiplicity',
			label: c(['値の数', 'Values', 'Werte', 'القيم']),
			kind: 'select',
			options: [
				{ value: 'single', label: c(['1 つ', 'One', 'Einer', 'واحدة']) },
				{ value: 'multi', label: c(['複数', 'Several', 'Mehrere', 'عدة']) }
			]
		},
		{
			key: 'nullable',
			label: c(['空を許可', 'May be empty', 'Darf leer sein', 'قد تكون فارغة']),
			kind: 'checkbox'
		},
		{
			key: 'classification',
			label: c(['区分', 'Class', 'Klasse', 'التصنيف']),
			kind: 'select',
			options: [
				{ value: 'pii', label: c(['個人情報', 'Personal', 'Personenbezogen', 'شخصية']) },
				{ value: 'internal', label: c(['内部', 'Internal', 'Intern', 'داخلية']) },
				{ value: 'public', label: c(['公開', 'Public', 'Öffentlich', 'عامة']) }
			]
		},
		{ key: 'required', label: c(['必須', 'Required', 'Erforderlich', 'مطلوب']), kind: 'checkbox' }
	]);

	const sources = $derived<MappingField[]>(
		profile.value.attributes
			.filter((a) => a.path.trim())
			.map((a) => ({
				key: a.path.trim(),
				label: a.label,
				type: a.type,
				example: EXAMPLES[a.path.trim()]
			}))
	);
</script>

<SaveScope draft={profile} onsave={() => new Promise((resolve) => setTimeout(resolve, 600))}>
	<div style="display:grid;gap:16px;max-width:1100px">
		<Card
			title={c(['受け取る属性', 'Attributes received', 'Empfangene Attribute', 'السمات المستلمة'])}
		>
			<EditableTable
				label={c(['SAML 属性', 'SAML attributes', 'SAML-Attribute', 'سمات SAML'])}
				{columns}
				field="attributes"
				bind:rows={profile.value.attributes}
				makeRow={() => attr('', '', 'string')}
			/>
		</Card>
		<Card
			title={c(['Authrim への取り込み', 'Into Authrim', 'Übernahme in Authrim', 'إلى Authrim'])}
		>
			<MappingEditor
				label={c(['属性のマッピング', 'Attribute mapping', 'Attributzuordnung', 'تعيين السمات'])}
				direction="inbound"
				sourceLabel={c(['SAML 属性', 'SAML attribute', 'SAML-Attribut', 'سمة SAML'])}
				{sources}
				{targets}
				field="mappings"
				bind:mappings={profile.value.mappings}
			/>
		</Card>
	</div>
</SaveScope>
