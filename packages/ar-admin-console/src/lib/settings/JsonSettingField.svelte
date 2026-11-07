<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { checkJson } from '#lib/ui/patterns/json.js';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import { sameValue } from '#lib/ui/save/draft.svelte.js';
	import { useInvalidReport } from '#lib/ui/save/save-scope.js';

	/**
	 * The value of a `json` setting (an object, such as operation → level) as JSON text. While the
	 * text is a JSON object the value is that object; otherwise the value holds the text itself, so
	 * the change still counts as unsaved, and the field reports it to its SaveScope so Save stops
	 * on it instead of sending.
	 */
	interface Props {
		label: string;
		value: unknown;
		/** Receives the parsed object while the text is valid, the text itself while it is not. */
		onvalue: (value: Record<string, unknown> | string) => void;
		error?: string;
		changed?: boolean;
		disabled?: boolean;
	}

	let { label, value, onvalue, error, changed, disabled = false }: Props = $props();

	const show = (v: unknown) =>
		typeof v === 'string' ? v : v === undefined || v === null ? '{}' : JSON.stringify(v, null, 2);

	let text = $state('');
	/** The value the text was last written from or parsed to. */
	let shown: unknown = Symbol('none');

	// Follow the value when it changes from outside (going back to the default, a reload). The
	// value comes back from the draft as a proxy of what was typed, so it is compared by content:
	// the admin's own text (its spacing and line breaks) is never rewritten while they type.
	$effect.pre(() => {
		if (sameValue(value, shown)) return;
		shown = value;
		text = show(value);
	});

	const check = $derived(checkJson(text));
	const isObject = (v: unknown): v is Record<string, unknown> =>
		v !== null && typeof v === 'object' && !Array.isArray(v);
	const problem = $derived.by(() => {
		if (check.state === 'invalid')
			return t('json.invalidAt', { line: check.line, column: check.column });
		if (check.state === 'empty' || !isObject(check.value)) return t('settings.json.object');
		return undefined;
	});

	const report = useInvalidReport();
	$effect(() => report(!disabled && problem !== undefined));

	function input(next: string): void {
		text = next;
		const parsed = checkJson(next);
		shown = parsed.state === 'valid' && isObject(parsed.value) ? parsed.value : next;
		onvalue(shown as Record<string, unknown> | string);
	}
</script>

<TextArea
	{label}
	hideLabel
	mono
	rows={5}
	dir="ltr"
	{changed}
	{disabled}
	error={disabled ? undefined : (problem ?? error)}
	bind:value={() => text, input}
/>
