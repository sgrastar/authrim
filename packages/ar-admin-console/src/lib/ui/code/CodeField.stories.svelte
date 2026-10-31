<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import ThemeMatrix from '../stories/ThemeMatrix.svelte';
	import { expect, userEvent, within } from 'storybook/test';
	import CodeField from './CodeField.svelte';
	import { CODE_SAMPLES, LONG_XML } from './samples';

	const { Story } = defineMeta({
		title: 'Primitives/Code field',
		component: CodeField,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Code input with syntax highlighting for JSON, JavaScript, CSS, XML and shell. `wrap` wraps long lines (line numbers stay beside their line); `wrapToggle` lets the viewer switch it with a checkbox; `copyable` adds a copy button. A transparent native `<textarea>` sits over the coloured copy, so typing, selection, undo, IME and screen readers behave like a normal field; highlighted tokens are rendered as text nodes, never as HTML. Tab moves focus as usual. Colours come from the `--code-*` theme tokens and meet WCAG AA in every theme. Code always reads left to right, also in RTL pages.'
				}
			}
		}
	});
</script>

<Story name="JSON">
	{#snippet template()}
		<div style="max-width:640px">
			<CodeField label={sample('codeJson')} language="json" value={CODE_SAMPLES.json} rows={9} />
		</div>
	{/snippet}
</Story>

<Story name="JavaScript">
	{#snippet template()}
		<div style="max-width:640px">
			<CodeField
				label={sample('codeJs')}
				language="javascript"
				value={CODE_SAMPLES.javascript}
				rows={10}
			/>
		</div>
	{/snippet}
</Story>

<Story name="CSS">
	{#snippet template()}
		<div style="max-width:640px">
			<CodeField label={sample('codeCss')} language="css" value={CODE_SAMPLES.css} rows={10} />
		</div>
	{/snippet}
</Story>

<Story name="XML">
	{#snippet template()}
		<div style="max-width:640px">
			<CodeField label={sample('codeXml')} language="xml" value={CODE_SAMPLES.xml} rows={7} />
		</div>
	{/snippet}
</Story>

<Story name="Shell (read-only)">
	{#snippet template()}
		<div style="max-width:640px">
			<CodeField
				label={sample('codeShell')}
				language="shell"
				value={CODE_SAMPLES.shell}
				rows={6}
				readonly
				hint={sample('readOnlyHint')}
			/>
		</div>
	{/snippet}
</Story>

<Story
	name="Wrap toggle and copy"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const wrap = canvas.getByRole('checkbox');
		await expect(wrap).not.toBeChecked();
		await userEvent.click(wrap);
		await expect(canvas.getByRole('textbox')).toHaveAttribute('wrap', 'soft');
	}}
>
	{#snippet template()}
		<div style="max-width:640px">
			<CodeField
				label={sample('codeXml')}
				language="xml"
				value={LONG_XML}
				rows={6}
				wrapToggle
				copyable
			/>
		</div>
	{/snippet}
</Story>

<Story name="Wrapped">
	{#snippet template()}
		<div style="max-width:640px">
			<CodeField
				label={sample('codeXml')}
				language="xml"
				value={LONG_XML}
				rows={8}
				wrap
				wrapToggle
				copyable
			/>
		</div>
	{/snippet}
</Story>

<Story name="All themes" parameters={{ layout: 'fullscreen' }}>
	{#snippet template()}
		<ThemeMatrix>
			<CodeField
				label="JSON"
				language="json"
				value={CODE_SAMPLES.json}
				rows={8}
				lineNumbers={false}
			/>
		</ThemeMatrix>
	{/snippet}
</Story>
