import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import storybook from 'eslint-plugin-storybook';
import globals from 'globals';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs['flat/recommended'],
	...storybook.configs['flat/recommended'],
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_'
				}
			]
		}
	},
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser
			}
		},
		rules: {
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		files: ['**/*.svelte.ts'],
		languageOptions: {
			parser: ts.parser,
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module'
			}
		},
		rules: {
			// Svelte 5 runes like $state require 'let' even though they're not reassigned
			'prefer-const': 'off'
		}
	},
	{
		// The whole-console mock (src/lib/mock) has no API behind it: no real API client, no session
		// or server code, no network. The in-memory fakes in $lib/api/fake are fine.
		files: [
			'src/lib/mock/**/*.ts',
			'src/lib/mock/**/*.svelte',
			'src/routes/mock/**/*.ts',
			'src/routes/mock/**/*.svelte'
		],
		rules: {
			'no-restricted-imports': 'off',
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					paths: [
						{ name: '$lib/api', message: 'The mock does not call the API.', allowTypeImports: true }
					],
					patterns: [
						{
							regex: '^\\$lib/api/(?!fake/)',
							message: 'The mock does not call the API. Use sample data, or $lib/api/fake.',
							allowTypeImports: true
						},
						{
							group: ['$lib/auth/*', '$lib/server/*', '$env/*'],
							message: 'The mock has no session, server code or environment.'
						}
					]
				}
			],
			'no-restricted-globals': [
				'error',
				{ name: 'fetch', message: 'The mock does not use the network.' },
				{ name: 'XMLHttpRequest', message: 'The mock does not use the network.' },
				{ name: 'WebSocket', message: 'The mock does not use the network.' },
				{ name: 'EventSource', message: 'The mock does not use the network.' }
			],
			'no-restricted-properties': [
				'error',
				{ object: 'window', property: 'fetch', message: 'The mock does not use the network.' },
				{ object: 'globalThis', property: 'fetch', message: 'The mock does not use the network.' },
				{
					object: 'navigator',
					property: 'sendBeacon',
					message: 'The mock does not use the network.'
				}
			]
		}
	},
	{
		ignores: ['build/', '.svelte-kit/', 'dist/', 'storybook-static/', '!.storybook']
	}
);
