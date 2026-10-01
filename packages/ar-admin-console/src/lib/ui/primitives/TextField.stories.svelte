<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import TextField from './TextField.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Text field',
		component: TextField,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Labelled text input. `hint`, `error` and the character count are linked to the input with `aria-describedby`; an error also sets `aria-invalid`. A `placeholder` shows an example of the expected format — never the label or an instruction, because it disappears as soon as the admin types. `counter` shows the length under the field (`12/100` with `maxlength`); it turns amber in the last tenth so the limit is not a surprise. Use it where a limit is likely to be reached (descriptions, messages), not on every field.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<div style="max-width:360px">
			<TextField
				label={sample('displayName')}
				value="Acme Corporation"
				hint={sample('displayNameHint')}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Error">
	{#snippet template()}
		<div style="max-width:360px">
			<TextField
				label={sample('redirectUri')}
				required
				value="http://"
				error={sample('redirectError')}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Placeholder">
	{#snippet template()}
		<div style="max-width:360px;display:grid;gap:20px">
			<TextField
				label={sample('contactEmail')}
				type="email"
				placeholder={sample('emailPlaceholder')}
			/>
			<TextField label={sample('contactEmail')} type="email" />
		</div>
	{/snippet}
</Story>

<Story
	name="Character count"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const [field] = canvas.getAllByRole('textbox');
		await userEvent.clear(field);
		await userEvent.type(field, 'Acme');
		await expect(canvas.getByText('4/60')).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<div style="max-width:360px;display:grid;gap:20px">
			<TextField label={sample('displayName')} value="Acme Corporation" maxlength={60} counter />
			<TextField
				label={sample('appDescription')}
				value={sample('appDescriptionValue')}
				hint={sample('appDescriptionHint')}
				maxlength={64}
				counter
			/>
			<TextField label={sample('displayName')} value="Acme Corporation" maxlength={60} />
		</div>
	{/snippet}
</Story>

<Story name="Sizes">
	{#snippet template()}
		<div style="display:grid;gap:16px;max-width:360px">
			<TextField label={sample('displayName')} value="Acme Corporation" />
			<TextField label={sample('displayName')} size="sm" value="Acme Corporation" />
		</div>
	{/snippet}
</Story>
