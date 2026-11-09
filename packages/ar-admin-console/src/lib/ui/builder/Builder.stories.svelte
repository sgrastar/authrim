<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import {
		LOGIN_UI_LOCALES,
		getLoginUILanguageDisplayName
	} from '@authrim/ar-lib-core/types/login-ui-languages';
	import { named, subcomponents } from '../stories/subcomponents';
	import PartPalette from './PartPalette.svelte';
	import {
		paletteEntries as screenPaletteEntries,
		paletteGroups as screenPaletteGroups
	} from '#lib/pages/customization/screens/screen-builder.js';
	import { PART_KINDS } from '#lib/pages/customization/screens/screen-model.js';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ScreenBuilderDemo from '../stories/ScreenBuilderDemo.svelte';
	import ScreenPreview from '#lib/pages/customization/screens/ScreenPreview.svelte';
	import { sample } from '../stories/sample';
	import type { LayoutRow } from './layout-model';
	import LayoutCanvas from './LayoutCanvas.svelte';
	import OptionListEditor from './OptionListEditor.svelte';
	import PreviewFrame from './PreviewFrame.svelte';
	import TranslationTable from './TranslationTable.svelte';

	// The props table's main tab (see named()).
	named(LayoutCanvas, 'LayoutCanvas');

	const { Story } = defineMeta({
		title: 'Patterns/Screen builder',
		component: LayoutCanvas,
		subcomponents: subcomponents({ PartPalette, PreviewFrame, TranslationTable, OptionListEditor }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Parts for building a page by arranging parts (the Login UI screens).\n\n- **LayoutCanvas** — the page as rows of one to three columns. Each row shows its column count as buttons drawn like the layout; fewer columns move the parts of the removed columns into the last one kept, so nothing is lost. Drag a part into any column (a line shows where it lands) or between rows to make a new row; drag a row by its grip. Keyboard: Alt + arrow keys move the focused part, and every move is read out.\n- **PartPalette** — the parts that can be added; drag one in, or click it to add it after the selected part.\n- **PreviewFrame** — the page at phone or desktop width, as a picture (inert).\n- **OptionListEditor** — the options of a dropdown or radio buttons: the label people see and the value that is stored, reordered with arrows; a value used twice is flagged.\n- **TranslationTable** — every text of the page side by side across supported languages. The source column stays fixed while language columns scroll; compact cells edit translations in place. Empty entries show the default wording, and language headings count what is left.\n\nThe layout itself lives in `layout-model.ts` (pure, unit-tested). Unlike the legacy editor, columns are a property of a row you can see and change — not a hidden marker between parts.'
				}
			}
		}
	});

	const part = (id: string, label: string, kind = 'text') => ({ id, kind, label });
	let rows = $state<LayoutRow[]>([
		{ id: 'r1', columns: [[part('title', 'Heading', 'heading')]] },
		{
			id: 'r2',
			columns: [[part('given', 'Given name', 'field')], [part('family', 'Family name', 'field')]]
		},
		{ id: 'r3', columns: [[part('note', 'Short note')]] }
	]);
	let selected = $state<string | null>(null);
	let options = $state([
		{ value: 'jp', label: 'Japan' },
		{ value: 'us', label: 'United States' },
		{ value: 'us', label: 'USA' }
	]);
	let translations = $state({ title: { ja: 'アカウントを作成' } } as Record<
		string,
		Record<string, string>
	>);

	/** The screen builder's parts, as the palette shows them. */
	const allKinds = PART_KINDS.map((def) => def.kind);
	const paletteGroups = () => screenPaletteGroups(allKinds);
	const paletteEntries = () => screenPaletteEntries(allKinds);
</script>

<Story name="Screen builder">
	{#snippet template()}<ScreenBuilderDemo />{/snippet}
</Story>

<Story
	name="Layout canvas"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const firstRow = canvas.getByRole('region', { name: t('builder.row', { n: 1 }) });
		// Three columns for the first row: two empty slots appear next to the heading.
		await userEvent.click(
			within(firstRow).getByRole('button', { name: t('builder.columnsN', { n: 3 }) })
		);
		await waitFor(() =>
			expect(
				within(firstRow).getByRole('group', { name: t('builder.column', { n: 3 }) })
			).toBeInTheDocument()
		);
		// Alt + → moves a part to the next column, and says so.
		const note = canvas.getByRole('button', { name: t('builder.select', { name: 'Short note' }) });
		note.focus();
		await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
		await waitFor(() =>
			expect(canvasElement.querySelector('[aria-live]')).toHaveTextContent('Short note')
		);
	}}
>
	{#snippet template()}
		<div style="max-width:760px">
			<LayoutCanvas
				label="Page"
				bind:rows
				bind:selected
				create={(kind) => part(`new-${Date.now()}`, kind)}
				role={(p) => ({ heading: 'Heading', field: 'Input field' })[p.kind] ?? 'Text'}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Preview frame">
	{#snippet template()}
		<PreviewFrame label={sample('screenName')}>
			<ScreenPreview {rows} />
		</PreviewFrame>
	{/snippet}
</Story>

<Story
	name="Translation table"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const translation = canvas.getByRole('textbox', {
			name: `${sample('partAuth')} — ${getLoginUILanguageDisplayName('ja', false)}`
		});
		await userEvent.type(translation, 'パスキーで作成');
		await expect(translation).toHaveValue('パスキーで作成');
	}}
>
	{#snippet template()}
		<div style="max-width:760px">
			<TranslationTable
				label={sample('tabLocalize')}
				source={{ code: '', name: t('sc.editor.sourceText') }}
				locales={LOGIN_UI_LOCALES.map((code) => ({
					code,
					name: getLoginUILanguageDisplayName(code, false)
				}))}
				rows={[
					{ id: 'title', label: sample('partHeading'), source: 'Create your account' },
					{ id: 'passkey', label: sample('partAuth'), source: 'Sign up with a passkey' },
					{ id: 'or', label: sample('partDivider'), source: 'or' }
				]}
				bind:values={translations}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Option list">
	{#snippet template()}
		<div style="max-width:420px"><OptionListEditor bind:options /></div>
	{/snippet}
</Story>

<Story name="Part palette">
	{#snippet template()}
		<div style="max-width:290px">
			<PartPalette entries={paletteEntries()} groups={paletteGroups()} onadd={() => {}} />
		</div>
	{/snippet}
</Story>
