<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { DEFAULT_REQUESTED_ATTRIBUTES } from '#lib/api/fake/federation-sources-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import FederationRequestedAttributes from './FederationRequestedAttributes.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Federation connection/Requested attributes',
		component: FederationRequestedAttributes,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'What the federation’s service providers ask for in their metadata (RequestedAttribute), as a table: each attribute with how many service providers require it and how many only ask. It sits in the input-and-output node under the output source, so the attributes some services cannot do without are looked for while the source is chosen or made. Given the attribute names of the source in use, or of the one being made as they are typed, each row says whether the source has it. In the mapping node the same counts appear as a line under an attribute of the open row, without that: the source’s own settings tell it. The counts come from lists kept when the metadata is imported; a snapshot imported before then reads fewer service providers until it is refreshed, and the table says so.'
				}
			}
		}
	});

	const ready = { phase: 'ready' as const, data: DEFAULT_REQUESTED_ATTRIBUTES, onretry: () => {} };
</script>

<Story
	name="A table of what is asked for"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const table = await canvas.findByRole('table', { name: t('sf.fed.req.title') });
		const rows = within(table).getAllByRole('row');
		// A header and one row per attribute.
		await expect(rows).toHaveLength(1 + DEFAULT_REQUESTED_ATTRIBUTES.attributes.length);
		await expect(
			within(table).getByRole('columnheader', { name: t('sf.fed.req.col.required') })
		).toBeVisible();
		const first = within(rows[1]);
		await first.findByText('eduPersonPrincipalName');
		// Required by 390 of the 412 that ask; the other 22 only ask.
		await first.findByText('390');
		await first.findByText('22');
		// No output source is chosen: no column says what it holds.
		await expect(
			within(table).queryByRole('columnheader', { name: t('sf.fed.req.col.source') })
		).toBeNull();
	}}
>
	{#snippet template()}
		<FederationRequestedAttributes {...ready} />
	{/snippet}
</Story>

<Story
	name="With the output source in use"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('columnheader', { name: t('sf.fed.req.col.source') });
		// The source has two of the four.
		await expect(canvas.getAllByText(t('sf.fed.req.sendable'))).toHaveLength(2);
		await expect(canvas.getAllByText(t('sf.fed.req.notSendable'))).toHaveLength(2);
	}}
>
	{#snippet template()}
		<FederationRequestedAttributes
			{...ready}
			sendable={new Set(['urn:oid:1.3.6.1.4.1.5923.1.1.1.6', 'urn:oid:0.9.2342.19200300.100.1.3'])}
		/>
	{/snippet}
</Story>

<Story
	name="Some service providers not counted yet"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.req.partial', { read: 120, total: 500 }));
		await canvas.findByText('eduPersonPrincipalName');
	}}
>
	{#snippet template()}
		<FederationRequestedAttributes
			{...ready}
			data={{ ...DEFAULT_REQUESTED_ATTRIBUTES, spRead: 120 }}
		/>
	{/snippet}
</Story>

<Story
	name="Nothing asked for"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.req.none'));
	}}
>
	{#snippet template()}
		<FederationRequestedAttributes {...ready} data={{ attributes: [], spTotal: 40, spRead: 40 }} />
	{/snippet}
</Story>

<Story
	name="Load failed and retried"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.req.loadFailed'));
		await userEvent.click(await canvas.findByRole('button', { name: t('common.retry') }));
	}}
>
	{#snippet template()}
		<FederationRequestedAttributes phase="failed" data={null} onretry={fn()} />
	{/snippet}
</Story>
