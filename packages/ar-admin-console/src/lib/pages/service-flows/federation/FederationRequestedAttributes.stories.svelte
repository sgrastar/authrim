<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import {
		createFakeFederationSources,
		DEFAULT_REQUESTED_ATTRIBUTES
	} from '#lib/api/fake/federation-sources-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import FederationRequestedAttributes from './FederationRequestedAttributes.svelte';
	import RequestedAttributesReloadHarness from './RequestedAttributesReloadHarness.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Federation connection/Requested attributes',
		component: FederationRequestedAttributes,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'What the federation’s service providers ask for in their metadata (RequestedAttribute), counted over them: each attribute with how many ask for it and how many mark it required. It sits in the mapping node, so the attributes some services cannot do without are not forgotten. Given the attribute names of the output source in use, each row also says whether the source has it. The counts come from lists kept when the metadata is imported; a snapshot imported before then reads fewer service providers until it is refreshed, and the card says so.'
				}
			}
		}
	});

	const ID = 'test-federation';
	const client = (requestedAttributes = DEFAULT_REQUESTED_ATTRIBUTES) =>
		createFakeFederationSources({ requestedAttributes });
</script>

<Story
	name="Counts and required marks"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('eduPersonPrincipalName');
		await canvas.findByText(t('sf.fed.req.required', { count: 390 }));
		await canvas.findByText(t('sf.fed.req.required', { count: 188 }));
		await canvas.findByText(t('sf.fed.req.askedBy', { count: 412 }));
		// Two attributes no service requires: optional.
		await expect(canvas.getAllByText(t('sf.fed.req.optional'))).toHaveLength(2);
		// No output source is chosen: nothing is said about what it can send.
		await expect(canvas.queryByText(t('sf.fed.req.sendable'))).toBeNull();
		await expect(canvas.queryByText(t('sf.fed.req.notSendable'))).toBeNull();
	}}
>
	{#snippet template()}
		<FederationRequestedAttributes client={client()} id={ID} />
	{/snippet}
</Story>

<Story
	name="With the output source in use"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('eduPersonPrincipalName');
		// The source has two of the four.
		await expect(canvas.getAllByText(t('sf.fed.req.sendable'))).toHaveLength(2);
		await expect(canvas.getAllByText(t('sf.fed.req.notSendable'))).toHaveLength(2);
	}}
>
	{#snippet template()}
		<FederationRequestedAttributes
			client={client()}
			id={ID}
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
			client={client({ ...DEFAULT_REQUESTED_ATTRIBUTES, spRead: 120 })}
			id={ID}
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
		<FederationRequestedAttributes
			client={client({ attributes: [], spTotal: 40, spRead: 40 })}
			id={ID}
		/>
	{/snippet}
</Story>

<Story
	name="Load failed and retried"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.req.loadFailed'));
		await expect(await canvas.findByRole('button', { name: t('common.retry') })).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: t('common.retry') }));
		await canvas.findByText(t('sf.fed.req.loadFailed'));
	}}
>
	{#snippet template()}
		<FederationRequestedAttributes client={client(new Error('down') as never)} id={ID} />
	{/snippet}
</Story>

<Story
	name="Read again after the metadata was refreshed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.req.partial', { read: 120, total: 500 }));
		// A refresh counts every service provider: the page bumps the key and the card reads again.
		await userEvent.click(canvas.getByRole('button', { name: 'Metadata refreshed' }));
		await waitFor(() =>
			expect(canvas.queryByText(t('sf.fed.req.partial', { read: 120, total: 500 }))).toBeNull()
		);
		await canvas.findByText('eduPersonPrincipalName');
	}}
>
	{#snippet template()}
		<RequestedAttributesReloadHarness
			answers={[{ ...DEFAULT_REQUESTED_ATTRIBUTES, spRead: 120 }, DEFAULT_REQUESTED_ATTRIBUTES]}
		/>
	{/snippet}
</Story>
