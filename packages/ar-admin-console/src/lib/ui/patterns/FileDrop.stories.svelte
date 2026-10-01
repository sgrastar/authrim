<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import FileDrop from './FileDrop.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/File upload',
		component: FileDrop,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Drop zone plus file picker. Dropped files get the same `accept` and size checks as picked ones (the file dialog filter does not apply to drag and drop); rejected files are listed with the reason. Nothing is uploaded until the form is saved.'
				}
			}
		}
	});

	const certificates = [
		new File(['-----BEGIN CERTIFICATE-----'], 'idp-signing.pem', {
			type: 'application/x-pem-file'
		}),
		new File(['x'.repeat(2400)], 'idp-encryption.pem', { type: 'application/x-pem-file' })
	];
</script>

<Story name="Single file">
	{#snippet template()}
		<div style="max-width:520px">
			<FileDrop label={sample('importUsers')} accept=".csv,.json" maxBytes={10 * 1024 * 1024} />
		</div>
	{/snippet}
</Story>

<Story name="Multiple files">
	{#snippet template()}
		<div style="max-width:520px">
			<FileDrop
				label={sample('certificates')}
				accept=".pem,.crt,.cer"
				maxBytes={512 * 1024}
				multiple
				files={certificates}
			/>
		</div>
	{/snippet}
</Story>
