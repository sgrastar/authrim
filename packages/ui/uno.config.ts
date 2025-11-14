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
		presetUno(), // Default preset with Tailwind-compatible utilities
		presetAttributify(), // Allows using utilities as HTML attributes
		presetIcons({
			// Icon support
			scale: 1.2,
			warn: true
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
				500: '#10B981',
				600: '#059669',
				700: '#047857'
			},
			warning: {
				50: '#FFFBEB',
				100: '#FEF3C7',
				500: '#F59E0B',
				600: '#D97706',
				700: '#B45309'
			},
			error: {
				50: '#FEF2F2',
				100: '#FEE2E2',
				500: '#EF4444',
				600: '#DC2626',
				700: '#B91C1C'
			},
			info: {
				50: '#EFF6FF',
				100: '#DBEAFE',
				500: '#3B82F6',
				600: '#2563EB',
				700: '#1D4ED8'
			}
		},
		fontFamily: {
			sans: ['Inter', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
			mono: ['Fira Code', 'Consolas', 'Monaco', 'Courier New', 'monospace']
		},
		fontSize: {
			xs: ['0.75rem', { lineHeight: '1rem' }],
			sm: ['0.875rem', { lineHeight: '1.25rem' }],
			base: ['1rem', { lineHeight: '1.5rem' }],
			lg: ['1.125rem', { lineHeight: '1.75rem' }],
			xl: ['1.25rem', { lineHeight: '1.75rem' }],
			'2xl': ['1.5rem', { lineHeight: '2rem' }],
			'3xl': ['1.875rem', { lineHeight: '2.25rem' }],
			'4xl': ['2.25rem', { lineHeight: '2.5rem' }],
			'5xl': ['3rem', { lineHeight: '3rem' }]
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
			'px-4 py-2 font-medium text-sm rounded-lg transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed',
		'btn-primary': 'btn-base bg-primary-500 text-white hover:bg-primary-600 focus:ring-primary-500',
		'btn-secondary': 'btn-base bg-gray-200 text-gray-700 hover:bg-gray-300 focus:ring-gray-400',
		'btn-ghost': 'btn-base text-primary-600 hover:bg-primary-50 focus:ring-primary-500',

		// Input shortcuts
		'input-base':
			'w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed',
		'input-error': 'input-base border-2 border-error-500 focus:ring-error-500',

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
		'btn-ghost'
	],
	rules: []
});
