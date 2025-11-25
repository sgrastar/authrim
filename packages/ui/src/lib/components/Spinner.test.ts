import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import SpinnerComponent from './Spinner.svelte';

// Cast to any to work around Svelte 5 / @testing-library/svelte type incompatibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Spinner = SpinnerComponent as any;

describe('Spinner', () => {
	it('renders with default props', () => {
		render(Spinner);

		const spinner = screen.getByRole('status');
		expect(spinner).toBeInTheDocument();
		expect(spinner).toHaveAttribute('aria-label', 'Loading');

		// Check for loading text
		const loadingText = screen.getByText('Loading...');
		expect(loadingText).toBeInTheDocument();
		expect(loadingText).toHaveClass('sr-only');
	});

	it('renders with small size', () => {
		render(Spinner, {
			props: {
				size: 'sm'
			}
		});

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('h-4', 'w-4');
	});

	it('renders with medium size (default)', () => {
		render(Spinner, {
			props: {
				size: 'md'
			}
		});

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('h-8', 'w-8');
	});

	it('renders with large size', () => {
		render(Spinner, {
			props: {
				size: 'lg'
			}
		});

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('h-12', 'w-12');
	});

	it('renders with extra large size', () => {
		render(Spinner, {
			props: {
				size: 'xl'
			}
		});

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('h-16', 'w-16');
	});

	it('renders with primary color (default)', () => {
		render(Spinner, {
			props: {
				color: 'primary'
			}
		});

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('text-primary-600');
	});

	it('renders with secondary color', () => {
		render(Spinner, {
			props: {
				color: 'secondary'
			}
		});

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('text-secondary-600');
	});

	it('renders with white color', () => {
		render(Spinner, {
			props: {
				color: 'white'
			}
		});

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('text-white');
	});

	it('renders with gray color', () => {
		render(Spinner, {
			props: {
				color: 'gray'
			}
		});

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('text-gray-600');
	});

	it('applies custom class name', () => {
		render(Spinner, {
			props: {
				class: 'my-custom-class'
			}
		});

		const spinner = screen.getByRole('status');
		expect(spinner).toHaveClass('my-custom-class');
		expect(spinner).toHaveClass('inline-block'); // base class
	});

	it('has animate-spin class on SVG', () => {
		render(Spinner);

		const spinner = screen.getByRole('status');
		const svg = spinner.querySelector('svg');
		expect(svg).toHaveClass('animate-spin');
	});
});
