import {
	defineConfig,
	presetAttributify,
	presetIcons,
	presetTypography,
	presetUno,
	presetWebFonts,
	transformerDirectives,
	transformerVariantGroup
} from 'unocss';

export default defineConfig({
	presets: [
		presetUno({
			dark: 'media' // Enable dark mode based on prefers-color-scheme
		}),
		presetAttributify(), // Allows using utilities as HTML attributes
		presetIcons({
			// Icon support
			scale: 1.2,
			warn: false
		}),
		presetTypography(), // Typography utilities
		presetWebFonts({
			provider: 'google',
			fonts: {
				sans: 'Inter:400,500,600,700',
				mono: 'Fira Code:400,500'
			}
		})
	],
	transformers: [
		transformerDirectives(), // Enables @apply, @screen directives
		transformerVariantGroup() // Enables hover:(bg-gray-400 font-medium)
	],
	theme: {
		colors: {
			// Primary Color (Blue) - Trust, security, professional
			primary: {
				50: '#EFF6FF',
				100: '#DBEAFE',
				200: '#BFDBFE',
				300: '#93C5FD',
				400: '#60A5FA',
				500: '#3B82F6', // Main
				600: '#2563EB',
				700: '#1D4ED8',
				800: '#1E40AF',
				900: '#1E3A8A'
			},
			// Secondary Color (Green) - Success, safety, authentication complete
			secondary: {
				50: '#ECFDF5',
				100: '#D1FAE5',
				500: '#10B981', // Main
				600: '#059669',
				700: '#047857'
			},
			// Semantic Colors
			success: {
				50: '#ECFDF5',
				100: '#D1FAE5',
				300: '#6EE7B7',
				500: '#10B981',
				600: '#059669',
				700: '#047857',
				800: '#065F46'
			},
			warning: {
				50: '#FFFBEB',
				100: '#FEF3C7',
				300: '#FCD34D',
				500: '#F59E0B',
				600: '#D97706',
				700: '#B45309',
				800: '#92400E'
			},
			error: {
				50: '#FEF2F2',
				100: '#FEE2E2',
				300: '#FCA5A5',
				400: '#F87171',
				500: '#EF4444',
				600: '#DC2626',
				700: '#B91C1C',
				800: '#991B1B'
			},
			info: {
				50: '#EFF6FF',
				100: '#DBEAFE',
				300: '#93C5FD',
				500: '#3B82F6',
				600: '#2563EB',
				700: '#1D4ED8',
				800: '#1E40AF'
			}
		},
		fontFamily: {
			sans: ['Inter', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
			mono: ['Fira Code', 'Consolas', 'Monaco', 'Courier New', 'monospace']
		},
		fontSize: {
			xs: ['0.75rem', { 'line-height': '1rem' }],
			sm: ['0.875rem', { 'line-height': '1.25rem' }],
			base: ['1rem', { 'line-height': '1.5rem' }],
			lg: ['1.125rem', { 'line-height': '1.75rem' }],
			xl: ['1.25rem', { 'line-height': '1.75rem' }],
			'2xl': ['1.5rem', { 'line-height': '2rem' }],
			'3xl': ['1.875rem', { 'line-height': '2.25rem' }],
			'4xl': ['2.25rem', { 'line-height': '2.5rem' }],
			'5xl': ['3rem', { 'line-height': '3rem' }]
		},
		boxShadow: {
			sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
			DEFAULT: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
			md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
			lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
			xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)'
		},
		borderRadius: {
			sm: '0.25rem',
			DEFAULT: '0.5rem',
			md: '0.5rem',
			lg: '0.75rem',
			xl: '1rem',
			full: '9999px'
		}
	},
	shortcuts: {
		// Button shortcuts
		'btn-base':
			'px-4 py-2 font-medium text-sm rounded-lg transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md inline-flex items-center justify-center gap-2',
		'btn-primary':
			'btn-base bg-primary-600 text-white hover:bg-primary-700 active:bg-primary-800 focus:ring-primary-500 dark:bg-primary-500 dark:hover:bg-primary-400 dark:active:bg-primary-600 dark:focus:ring-primary-400',
		'btn-secondary':
			'btn-base bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200 active:bg-gray-300 focus:ring-gray-400 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600 dark:hover:bg-gray-600 dark:active:bg-gray-500 dark:focus:ring-gray-500',
		'btn-ghost':
			'btn-base text-primary-600 hover:bg-primary-50 active:bg-primary-100 focus:ring-primary-500 dark:text-primary-400 dark:hover:bg-primary-900/30 dark:active:bg-primary-900/50 dark:focus:ring-primary-400',
		'btn-danger':
			'btn-base bg-error-600 text-white hover:bg-error-700 active:bg-error-800 focus:ring-error-500 dark:bg-error-500 dark:hover:bg-error-400 dark:active:bg-error-600 dark:focus:ring-error-400',

		// Input shortcuts
		'input-base':
			'w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 bg-white focus:outline-none focus:ring-2 focus:ring-primary-700 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed dark:bg-gray-800 dark:border-gray-600 dark:text-white dark:placeholder-gray-500 dark:focus:ring-primary-600 dark:disabled:bg-gray-700',
		'input-error':
			'input-base border-2 border-error-500 focus:ring-error-500 dark:border-error-400 dark:focus:ring-error-400',

		// Card shortcuts
		card: 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-6',

		// Badge shortcuts
		'badge-base': 'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
		'badge-success':
			'badge-base bg-success-100 text-success-800 dark:bg-success-800/20 dark:text-success-300',
		'badge-warning':
			'badge-base bg-warning-100 text-warning-800 dark:bg-warning-800/20 dark:text-warning-300',
		'badge-error':
			'badge-base bg-error-100 text-error-800 dark:bg-error-800/20 dark:text-error-300',
		'badge-info': 'badge-base bg-info-100 text-info-800 dark:bg-info-800/20 dark:text-info-300'
	},
	safelist: [
		// Ensure button shortcuts are always generated
		'btn-primary',
		'btn-secondary',
		'btn-ghost',
		'btn-danger'
	],
	rules: []
});
