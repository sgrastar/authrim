<script lang="ts">
	import Card from '../patterns/Card.svelte';
	import EditableTable, { type EditColumn } from '../patterns/EditableTable.svelte';
	import MappingEditor from '../patterns/MappingEditor.svelte';
	import type { Mapping, MappingField, MappingType } from '../patterns/mapping-model';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { localized } from './sample';

	/**
	 * Storybook demo: an outbound destination (a SAML SP, an expense app). The attributes the
	 * app expects are defined in the table; below, which of Authrim's attributes fills each.
	 * TODO(api): destination profiles and outbound mapping versions of the field-mapping API.
	 */
	interface Attribute extends Record<string, unknown> {
		name: string;
		label: string;
		type: MappingType;
		required: boolean;
	}
	interface Destination {
		attributes: Attribute[];
		mappings: Mapping[];
	}

	const attr = (name: string, label: string, type: MappingType, required = false): Attribute => ({
		name,
		label,
		type,
		required
	});

	const destination = new Draft<Destination>({
		attributes: [
			attr('NameID', 'Subject', 'string', true),
			attr('mail', 'Email', 'string', true),
			attr('displayName', 'Display name', 'string'),
			attr('givenName', 'Given name', 'string'),
			attr('sn', 'Surname', 'string'),
			attr('memberOf', 'Groups', 'string[]'),
			attr('costCenter', 'Cost centre', 'string')
		],
		mappings: [
			{ id: 'o1', target: 'NameID', sources: ['sub'], steps: [] },
			{
				id: 'o2',
				target: 'mail',
				sources: ['email'],
				steps: [{ id: 'st1', transform: 'case', params: { mode: 'lower' } }]
			},
			{ id: 'o3', target: 'displayName', sources: ['name'], steps: [] },
			{ id: 'o4', target: 'costCenter', sources: ['groups'], steps: [] }
		]
	});

	/** Authrim's attributes, with a sample user's values for the preview. */
	const authrim: MappingField[] = [
		{ key: 'sub', label: 'User ID', type: 'string', example: 'usr_01J8Z4K3M2' },
		{ key: 'email', label: 'Email', type: 'string', example: 'John.Smith@Example.com' },
		{ key: 'email_verified', label: 'Email verified', type: 'boolean' },
		{ key: 'name', label: 'Name', type: 'string', example: 'John Smith' },
		{ key: 'given_name', label: 'Given name', type: 'string', example: 'John' },
		{ key: 'family_name', label: 'Family name', type: 'string', example: 'Smith' },
		{ key: 'department', label: 'Department', type: 'string', example: 'Sales' },
		{ key: 'groups', label: 'Groups', type: 'string[]', example: ['sales', 'admins'] }
	];

	const c = (copy: readonly [string, string, string, string]) => localized(copy);
	const columns = $derived<EditColumn[]>([
		{
			key: 'name',
			label: c(['属性名', 'Name', 'Name', 'الاسم']),
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
		{ key: 'required', label: c(['必須', 'Required', 'Erforderlich', 'مطلوب']), kind: 'checkbox' }
	]);

	const targets = $derived<MappingField[]>(
		destination.value.attributes
			.filter((a) => a.name.trim())
			.map((a) => ({ key: a.name.trim(), label: a.label, type: a.type, required: a.required }))
	);
</script>

<SaveScope draft={destination} onsave={() => new Promise((resolve) => setTimeout(resolve, 600))}>
	<div style="display:grid;gap:16px;max-width:1100px">
		<Card
			title={c([
				'送り先が受け取る属性',
				'Attributes the app expects',
				'Erwartete Attribute',
				'السمات المتوقعة'
			])}
		>
			<EditableTable
				label={c([
					'経費精算アプリ（SAML SP）の属性',
					'Expense app (SAML SP) attributes',
					'Attribute der Spesen-App (SAML SP)',
					'سمات تطبيق النفقات (SAML SP)'
				])}
				{columns}
				field="attributes"
				bind:rows={destination.value.attributes}
				makeRow={() => attr('', '', 'string')}
			/>
		</Card>
		<Card title={c(['Authrim からの送り出し', 'From Authrim', 'Aus Authrim', 'من Authrim'])}>
			<MappingEditor
				label={c(['属性のマッピング', 'Attribute mapping', 'Attributzuordnung', 'تعيين السمات'])}
				direction="outbound"
				targetLabel={c(['SAML SP の属性', 'SAML SP attribute', 'SAML-SP-Attribut', 'سمة SAML SP'])}
				sources={authrim}
				{targets}
				field="mappings"
				bind:mappings={destination.value.mappings}
			/>
		</Card>
	</div>
</SaveScope>
