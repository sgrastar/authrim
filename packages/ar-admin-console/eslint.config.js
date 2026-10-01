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
		ignores: ['build/', '.svelte-kit/', 'dist/', 'storybook-static/', '!.storybook']
	}
);
