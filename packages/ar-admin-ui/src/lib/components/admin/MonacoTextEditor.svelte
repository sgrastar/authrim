<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
	import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
	import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
	import type * as MonacoApi from 'monaco-editor/esm/vs/editor/editor.api.js';

	type EditorLanguage = 'authrim-consent-html' | 'html' | 'css';

	interface Props {
		value?: string;
		language?: EditorLanguage;
		disabled?: boolean;
		placeholder?: string;
		ariaLabel?: string;
		minHeight?: number;
		onchange?: (value: string) => void;
	}

	let {
		value = $bindable(''),
		language = 'authrim-consent-html',
		disabled = false,
		placeholder = '',
		ariaLabel = 'Code editor',
		minHeight = 180,
		onchange
	}: Props = $props();

	let container = $state<HTMLDivElement>();
	let editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
	let monacoApi: typeof MonacoApi | null = null;
	let loadError = $state('');
	let ready = $state(false);
	let themeObserver: MutationObserver | null = null;

	const authrimConsentLanguageId = 'authrim-consent-html';
	const lightThemeId = 'authrim-admin-editor-light';
	const darkThemeId = 'authrim-admin-editor-dark';

	onMount(() => {
		if (!browser || !container) return;
		void initializeEditor();
	});

	async function initializeEditor() {
		if (!container) return;
		try {
			configureMonacoWorkers();
			const monaco = await import('monaco-editor/esm/vs/editor/editor.api.js');
			await Promise.all([
				import('monaco-editor/esm/vs/basic-languages/html/html.contribution.js'),
				import('monaco-editor/esm/vs/basic-languages/css/css.contribution.js')
			]);
			monacoApi = monaco;
			registerAuthrimConsentLanguage(monaco);
			registerAuthrimThemes(monaco);
			editor = monaco.editor.create(container, {
				value,
				language,
				theme: currentThemeId(),
				readOnly: disabled,
				ariaLabel,
				automaticLayout: true,
				contextmenu: true,
				fontFamily:
					'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
				fontSize: 13,
				lineHeight: 20,
				lineNumbers: 'off',
				lineDecorationsWidth: 0,
				lineNumbersMinChars: 0,
				glyphMargin: false,
				folding: false,
				minimap: { enabled: false },
				overviewRulerLanes: 0,
				hideCursorInOverviewRuler: true,
				scrollBeyondLastLine: false,
				wordWrap: 'on',
				wrappingIndent: 'same',
				renderLineHighlight: 'line',
				padding: { top: 10, bottom: 10 },
				tabSize: 2,
				insertSpaces: false,
				stickyScroll: { enabled: false },
				quickSuggestions: false,
				suggestOnTriggerCharacters: false,
				acceptSuggestionOnEnter: 'off',
				wordBasedSuggestions: 'off',
				links: true,
				scrollbar: {
					verticalScrollbarSize: 10,
					horizontalScrollbarSize: 10,
					alwaysConsumeMouseWheel: false
				}
			});
			editor.onDidChangeModelContent(() => {
				const nextValue = editor?.getValue() ?? '';
				if (nextValue !== value) {
					value = nextValue;
					onchange?.(nextValue);
				}
			});
			themeObserver = new MutationObserver(() => updateTheme());
			themeObserver.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ['data-theme']
			});
			ready = true;
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Failed to load editor.';
		}
	}

	onDestroy(() => {
		themeObserver?.disconnect();
		themeObserver = null;
		editor?.dispose();
		editor = null;
	});

	$effect(() => {
		if (!editor) return;
		const model = editor.getModel();
		if (model && model.getValue() !== value) {
			editor.setValue(value);
		}
	});

	$effect(() => {
		if (!editor) return;
		editor.updateOptions({ readOnly: disabled });
	});

	$effect(() => {
		if (!editor || !monacoApi) return;
		const model = editor.getModel();
		if (model) monacoApi.editor.setModelLanguage(model, language);
	});

	function configureMonacoWorkers() {
		const scope = globalThis as typeof globalThis & {
			MonacoEnvironment?: {
				getWorker(_workerId: string, label: string): Worker;
			};
		};
		scope.MonacoEnvironment = {
			getWorker(_workerId: string, label: string) {
				if (label === 'html' || label === 'handlebars' || label === 'razor') {
					return new HtmlWorker();
				}
				if (label === 'css' || label === 'scss' || label === 'less') {
					return new CssWorker();
				}
				return new EditorWorker();
			}
		};
	}

	function registerAuthrimConsentLanguage(monaco: typeof MonacoApi) {
		if (!monaco.languages.getLanguages().some((item) => item.id === authrimConsentLanguageId)) {
			monaco.languages.register({
				id: authrimConsentLanguageId,
				aliases: ['Authrim consent HTML', 'authrim-consent-html'],
				extensions: ['.html']
			});
			monaco.languages.setMonarchTokensProvider(authrimConsentLanguageId, {
				defaultToken: '',
				tokenPostfix: '.authrim-consent',
				tokenizer: {
					root: [
						[/<!--/, 'comment', '@comment'],
						[/%link\d+%/, 'authrim-link-token'],
						[
							/%(?:identity_schema|destination_field_mapping_set|user_decision|binding_list|subject)%/,
							'authrim-placeholder-token'
						],
						[/%[a-zA-Z0-9_:-]+%/, 'authrim-unknown-token'],
						[/(<\/?)([a-zA-Z][\w:-]*)(\s*)/, ['delimiter.html', 'tag.html', '@tag']],
						[/&[a-zA-Z0-9#]+;/, 'string.escape'],
						[/[^<&%]+/, ''],
						[/[<&%]/, '']
					],
					comment: [
						[/[^-]+/, 'comment'],
						[/-->/, 'comment', '@pop'],
						[/[-]/, 'comment']
					],
					tag: [
						[/\s+/, ''],
						[/\/?>/, 'delimiter.html', '@pop'],
						[/%link\d+%/, 'authrim-link-token'],
						[
							/%(?:identity_schema|destination_field_mapping_set|user_decision|binding_list|subject)%/,
							'authrim-placeholder-token'
						],
						[/%[a-zA-Z0-9_:-]+%/, 'authrim-unknown-token'],
						[/[a-zA-Z_:][\w:.-]*/, 'attribute.name'],
						[/=/, 'delimiter'],
						[/"[^"]*"/, 'attribute.value'],
						[/'[^']*'/, 'attribute.value']
					]
				}
			});
		}
	}

	function registerAuthrimThemes(monaco: typeof MonacoApi) {
		monaco.editor.defineTheme(lightThemeId, {
			base: 'vs',
			inherit: true,
			rules: [
				{ token: 'tag.html', foreground: '2563eb' },
				{ token: 'delimiter.html', foreground: '64748b' },
				{ token: 'attribute.name', foreground: '7c3aed' },
				{ token: 'attribute.value', foreground: '047857' },
				{ token: 'string.escape', foreground: '0891b2' },
				{ token: 'authrim-link-token', foreground: '0f6ec7', fontStyle: 'bold' },
				{ token: 'authrim-placeholder-token', foreground: '7c3aed', fontStyle: 'bold' },
				{ token: 'authrim-unknown-token', foreground: 'dc2626', fontStyle: 'underline' }
			],
			colors: {
				'editor.background': '#ffffff',
				'editor.foreground': '#1f2937',
				'editorLineNumber.foreground': '#94a3b8',
				'editorCursor.foreground': '#2563eb',
				'editor.selectionBackground': '#bfdbfe',
				'editor.lineHighlightBackground': '#f8fafc',
				'editorIndentGuide.background1': '#e5e7eb'
			}
		});
		monaco.editor.defineTheme(darkThemeId, {
			base: 'vs-dark',
			inherit: true,
			rules: [
				{ token: 'tag.html', foreground: '93c5fd' },
				{ token: 'delimiter.html', foreground: '94a3b8' },
				{ token: 'attribute.name', foreground: 'c4b5fd' },
				{ token: 'attribute.value', foreground: '86efac' },
				{ token: 'string.escape', foreground: '67e8f9' },
				{ token: 'authrim-link-token', foreground: '60a5fa', fontStyle: 'bold' },
				{ token: 'authrim-placeholder-token', foreground: 'c084fc', fontStyle: 'bold' },
				{ token: 'authrim-unknown-token', foreground: 'f87171', fontStyle: 'underline' }
			],
			colors: {
				'editor.background': '#1b1f2a',
				'editor.foreground': '#e5e7eb',
				'editorCursor.foreground': '#93c5fd',
				'editor.selectionBackground': '#334155',
				'editor.lineHighlightBackground': '#222838',
				'editorIndentGuide.background1': '#374151'
			}
		});
	}

	function currentThemeId(): string {
		return document.documentElement.getAttribute('data-theme') === 'dark'
			? darkThemeId
			: lightThemeId;
	}

	function updateTheme() {
		if (!monacoApi) return;
		monacoApi.editor.setTheme(currentThemeId());
	}
</script>

<div
	class="monaco-editor-shell"
	class:loading={!ready && !loadError}
	class:disabled
	style:--monaco-editor-min-height={`${minHeight}px`}
>
	{#if loadError}
		<textarea
			class="monaco-editor-fallback"
			bind:value
			{placeholder}
			aria-label={ariaLabel}
			{disabled}
			oninput={(event) => onchange?.(event.currentTarget.value)}
		></textarea>
	{:else}
		<div bind:this={container} class="monaco-editor-container" aria-label={ariaLabel}></div>
		{#if !ready}
			<div class="monaco-editor-loading">Loading editor...</div>
		{/if}
	{/if}
</div>

<style>
	.monaco-editor-shell {
		position: relative;
		min-height: var(--monaco-editor-min-height);
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
	}

	.monaco-editor-shell:focus-within {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px var(--color-accent-muted);
	}

	.monaco-editor-shell.disabled {
		opacity: 0.62;
	}

	.monaco-editor-container {
		min-height: var(--monaco-editor-min-height);
	}

	.monaco-editor-fallback {
		width: 100%;
		min-height: var(--monaco-editor-min-height);
		padding: 10px 12px;
		border: 0;
		background: transparent;
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.84rem;
		line-height: 1.5;
		resize: vertical;
	}

	.monaco-editor-fallback:focus {
		outline: none;
	}

	.monaco-editor-loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		background: var(--control-bg, var(--color-surface));
	}

	:global(.monaco-editor .scroll-decoration) {
		box-shadow: none;
	}
</style>
