import { expect, test } from '@playwright/test';

for (const route of ['/login', '/signup']) {
  test(`${route} keeps bottom controls above the footer`, async ({ page }) => {
    await page.setViewportSize({ width: 1290, height: 750 });
    await page.goto(route, { waitUntil: 'domcontentloaded' });

    const themeBoundary = page.locator('.login-ui-theme-boundary');
    const authPage = page.locator('.auth-page');
    const controls = page.locator('.auth-main > .auth-topbar');
    const footer = page.locator('.auth-page-footer');

    await expect(authPage).toHaveClass(/auth-page--has-footer/);
    await expect(controls).toBeVisible();
    await expect(footer).toBeVisible();
    await page.waitForTimeout(500);

    await themeBoundary.evaluate((element) => {
      element.setAttribute('data-page-layout', 'split_panel');
      element.setAttribute('data-topbar-position', 'bottom_right');
    });

    await expect(controls).toHaveCSS('position', 'absolute');

    const controlsBox = await controls.boundingBox();
    const footerBox = await footer.boundingBox();

    expect(controlsBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(footerBox!.y);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(controls).toHaveCSS('position', 'static');

    const mobileControlsBox = await controls.boundingBox();
    const mobileFooterBox = await footer.boundingBox();

    expect(mobileControlsBox).not.toBeNull();
    expect(mobileFooterBox).not.toBeNull();
    expect(mobileControlsBox!.y + mobileControlsBox!.height).toBeLessThanOrEqual(
      mobileFooterBox!.y
    );
  });

  test(`${route} covers the full mobile main region with the split panel surface`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route, { waitUntil: 'domcontentloaded' });

    const themeBoundary = page.locator('.login-ui-theme-boundary');
    const main = page.locator('.auth-main');
    const panel = page.locator('.auth-container');
    const footer = page.locator('.auth-page-footer');

    await expect(page.locator('html')).toHaveAttribute('data-branding-loaded', '');
    await themeBoundary.evaluate((element) => {
      element.setAttribute('data-page-layout', 'split_panel');
      element.setAttribute('data-split-background-mode', 'shared');
    });

    await expect(themeBoundary).toHaveAttribute('data-page-layout', 'split_panel');
    await expect(themeBoundary).toHaveAttribute('data-split-background-mode', 'shared');
    await expect(main).toHaveCSS('position', 'relative');
    await expect(panel).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    const surface = await main.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter,
        backgroundColor: style.backgroundColor,
        reducesTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      };
    });
    expect(surface.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    if (!surface.reducesTransparency) {
      expect(surface.backdropFilter).toContain('blur(32px)');
    }

    const mainBox = await main.boundingBox();
    const footerBox = await footer.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(Math.abs(mainBox!.y + mainBox!.height - footerBox!.y)).toBeLessThanOrEqual(1);
  });
}
