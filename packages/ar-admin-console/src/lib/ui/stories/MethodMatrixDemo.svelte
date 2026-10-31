<script lang="ts">
	import Card from '../patterns/Card.svelte';
	import CellText from '../patterns/CellText.svelte';
	import DataTable, { type Column } from '../patterns/DataTable.svelte';
	import NotApplicable from '../patterns/NotApplicable.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import Link from '../primitives/Link.svelte';
	import { sample, type SampleKey } from './sample';

	/**
	 * Storybook demo: where each built-in method may be used. A matrix of checkboxes — the
	 * choices are confirmed together with Save, so they are checkboxes, not switches. Cells that
	 * do not apply show a dash, not a disabled box.
	 */
	type Use = 'signup' | 'login' | 'reauth' | 'linking';
	interface Method {
		id: string;
		name: SampleKey;
		description: SampleKey;
		link?: SampleKey;
		/** Uses this method supports; the rest are not applicable. */
		supports: readonly Use[];
	}

	const USES: Array<[Use, SampleKey]> = [
		['signup', 'useSignup'],
		['login', 'useLogin'],
		['reauth', 'useReauth'],
		['linking', 'useLinking']
	];
	const ALL: Use[] = ['signup', 'login', 'reauth', 'linking'];
	const METHODS: Method[] = [
		{ id: 'passkey', name: 'passkey', description: 'passkeyDesc', supports: ALL },
		{ id: 'email', name: 'emailCode', description: 'emailCodeDesc', supports: ALL },
		{ id: 'totp', name: 'methodTotp', description: 'methodTotpDesc', supports: ALL },
		{
			id: 'directory',
			name: 'methodDirectory',
			description: 'methodDirectoryDesc',
			link: 'methodDirectoryLink',
			supports: ['login']
		}
	];

	const uses = new Draft<Record<string, Use[]>>({
		passkey: [...ALL],
		email: [],
		totp: [],
		directory: []
	});

	const columns = $derived<Column[]>([
		{ key: 'method', label: sample('colMethod'), width: '40%' },
		...USES.map(([use, label]): Column => ({ key: use, label: sample(label), align: 'center' }))
	]);

	function toggle(method: string, use: Use, on: boolean) {
		const current = uses.value[method];
		uses.value[method] = on ? [...current, use] : current.filter((other) => other !== use);
	}

	/** A cell is changed when it is on now but was off when saved, or the other way round. */
	function cellChanged(method: string, use: Use): boolean {
		const saved = (uses.original(method) as Use[] | undefined) ?? [];
		return saved.includes(use) !== uses.value[method].includes(use);
	}

	const save = () => new Promise((resolve) => setTimeout(resolve, 900)).then(() => {});
</script>

<SaveScope draft={uses} onsave={save}>
	<Card title={sample('builtInMethods')} description={sample('builtInDesc')} flush>
		<DataTable
			caption={sample('builtInMethods')}
			{columns}
			rows={METHODS}
			rowKey={(method) => method.id}
			rowChanged={(method) => uses.changed(method.id)}
		>
			{#snippet cell(method, column)}
				{#if column.key === 'method'}
					<CellText title={sample(method.name)} description={sample(method.description)}>
						{#if method.link}<Link href="#directory" standalone>{sample(method.link)}</Link>{/if}
					</CellText>
				{:else if method.supports.includes(column.key as Use)}
					<Checkbox
						hideLabel
						checked={uses.value[method.id].includes(column.key as Use)}
						changed={cellChanged(method.id, column.key as Use)}
						onchange={(event) => toggle(method.id, column.key as Use, event.currentTarget.checked)}
					>
						{sample(method.name)} — {column.label}
					</Checkbox>
				{:else}
					<NotApplicable />
				{/if}
			{/snippet}
		</DataTable>
	</Card>
</SaveScope>
