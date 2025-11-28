import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Accessibility (WCAG 2.1 AA)', () => {
	test('homepage should not have accessibility violations', async ({ page }) => {
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const accessibilityScanResults = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();

		expect(accessibilityScanResults.violations).toEqual([]);
	});

	test('login page should not have accessibility violations', async ({ page }) => {
		await page.goto('/login');
		await page.waitForLoadState('networkidle');

		const accessibilityScanResults = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();

		expect(accessibilityScanResults.violations).toEqual([]);
	});

	test('signup page should not have accessibility violations', async ({ page }) => {
		await page.goto('/signup');
		await page.waitForLoadState('networkidle');

		const accessibilityScanResults = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();

		expect(accessibilityScanResults.violations).toEqual([]);
	});

	test('consent page should not have accessibility violations', async ({ page }) => {
		// Note: Consent page may require authentication/parameters
		// This is a basic test that can be expanded with proper setup
		await page.goto('/consent');

		const accessibilityScanResults = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();

		// Log violations for debugging
		if (accessibilityScanResults.violations.length > 0) {
			console.log('Accessibility violations:', JSON.stringify(accessibilityScanResults.violations, null, 2));
		}

		expect(accessibilityScanResults.violations).toEqual([]);
	});

	test('error page should not have accessibility violations', async ({ page }) => {
		await page.goto('/error');

		const accessibilityScanResults = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();

		expect(accessibilityScanResults.violations).toEqual([]);
	});

	test.describe('Color Contrast', () => {
		test('should meet color contrast requirements on homepage', async ({ page }) => {
			await page.goto('/');
			await page.waitForLoadState('networkidle');

			const accessibilityScanResults = await new AxeBuilder({ page })
				.withTags(['wcag2aa'])
				.options({ rules: { 'color-contrast': { enabled: true } } })
				.analyze();

			const contrastViolations = accessibilityScanResults.violations.filter(
				(violation) => violation.id === 'color-contrast'
			);

			expect(contrastViolations).toEqual([]);
		});
	});

	test.describe('Keyboard Navigation', () => {
		test('should allow keyboard navigation on homepage', async ({ page }) => {
			await page.goto('/');
			await page.waitForLoadState('networkidle');

			// Press Tab multiple times to navigate
			await page.keyboard.press('Tab');
			let focusedElement = await page.evaluate(() => document.activeElement?.tagName);
			expect(focusedElement).toBeTruthy();

			await page.keyboard.press('Tab');
			focusedElement = await page.evaluate(() => document.activeElement?.tagName);
			expect(focusedElement).toBeTruthy();
		});

		test('should have visible focus indicators', async ({ page }) => {
			await page.goto('/');
			await page.waitForLoadState('networkidle');

			// Check for focus-visible styles
			const accessibilityScanResults = await new AxeBuilder({ page })
				.options({ rules: { 'focus-order-semantics': { enabled: true } } })
				.analyze();

			expect(accessibilityScanResults.violations).toEqual([]);
		});
	});

	test.describe('ARIA Labels', () => {
		test('should have valid ARIA attributes', async ({ page }) => {
			await page.goto('/');
			await page.waitForLoadState('networkidle');

			const accessibilityScanResults = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa'])
				.options({
					rules: {
						'aria-allowed-attr': { enabled: true },
						'aria-required-attr': { enabled: true },
						'aria-valid-attr-value': { enabled: true },
						'aria-valid-attr': { enabled: true },
					},
				})
				.analyze();

			const ariaViolations = accessibilityScanResults.violations.filter(
				(violation) => violation.id.startsWith('aria-')
			);

			expect(ariaViolations).toEqual([]);
		});
	});

	test.describe('Form Labels', () => {
		test('should have labels for all form inputs on login page', async ({ page }) => {
			await page.goto('/login');
			await page.waitForLoadState('networkidle');

			const accessibilityScanResults = await new AxeBuilder({ page })
				.options({
					rules: {
						'label': { enabled: true },
						'label-title-only': { enabled: true },
					},
				})
				.analyze();

			const labelViolations = accessibilityScanResults.violations.filter(
				(violation) => violation.id === 'label' || violation.id === 'label-title-only'
			);

			expect(labelViolations).toEqual([]);
		});
	});
});
