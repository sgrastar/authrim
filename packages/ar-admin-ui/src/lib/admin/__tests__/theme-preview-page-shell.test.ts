import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
	resolve(__dirname, '../../../routes/admin/themes/+page.svelte'),
	'utf8'
);
const enMessages = readFileSync(resolve(__dirname, '../../../i18n/en/admin-other.ts'), 'utf8');
const jaMessages = readFileSync(resolve(__dirname, '../../../i18n/ja/admin-other.ts'), 'utf8');

describe('theme preview page shell', () => {
	it('previews the header in the auth panel and the footer outside the split main area', () => {
		const headerIndex = source.indexOf('class="preview-auth-header"');
		const mainIndex = source.indexOf('class="preview-main"');
		const panelIndex = source.indexOf('class="preview-auth-container"');
		const footerIndex = source.indexOf('class="preview-footer preview-page-footer"');

		expect(headerIndex).toBeGreaterThan(-1);
		expect(panelIndex).toBeGreaterThan(mainIndex);
		expect(headerIndex).toBeGreaterThan(panelIndex);
		expect(footerIndex).toBeGreaterThan(headerIndex);
		expect(source).not.toContain('preview-page-header');
		expect(source).toContain('.login-preview-page.split .preview-main');
		expect(source).toContain('.login-preview-page.split > .preview-page-footer');
	});

	it('keeps preview controls on the shared compact scale across templates', () => {
		expect(source).toContain('--preview-card-padding: 20px;');
		expect(source).toContain('--preview-control-height: 44px;');
		expect(source).toContain('--preview-heading-size: 1.25rem;');
		expect(source).toContain('min-height: var(--preview-control-height);');
		expect(source).toContain('font-size: var(--preview-header-title-size);');
		expect(source).not.toContain('min-height: 38px;');
		expect(source).not.toContain('min-height: 40px;');
	});

	it('keeps localized text editing outside the preview inspector and before image assets', () => {
		const textCardIndex = source.indexOf('class="settings-form-card text-card"');
		const pageTitleCardIndex = source.indexOf('class="settings-form-card page-title-card"');
		const imageAssetsIndex = source.indexOf('<h2>Image assets</h2>');

		expect(textCardIndex).toBeGreaterThan(-1);
		expect(pageTitleCardIndex).toBeGreaterThan(textCardIndex);
		expect(imageAssetsIndex).toBeGreaterThan(pageTitleCardIndex);
		expect(source).toContain("getCurrentValue('login-ui.supported_locales')");
		expect(source).toContain("handleEditorChange('login-ui.brand_name'");
		expect(source).toContain("'login-ui.text_localizations'");
		expect(source).toContain("'loginTitle'");
		expect(source).toContain("'registrationTitle'");
		expect(source).toContain("'accountTitle'");
		expect(source).toContain('class="page-title-fields"');
		expect(source).toContain('grid-template-columns: minmax(0, 1fr);');
		expect(source).toContain('sanitizeFooterHtml(previewFooterText)');
		expect(source).toContain('admin_theme_text_footer_help');
		expect(source).not.toContain("$previewInspectorItem('brand-copy')");
		expect(source).not.toContain("handleEditorChange('login-ui.footer_text'");
	});

	it('separates custom themes from built-in templates in a one-column dated list', () => {
		const customThemeCardIndex = source.indexOf('class="settings-form-card custom-theme-card"');
		const templateCardIndex = source.indexOf('{$LL.admin_theme_templates_title()}');

		expect(customThemeCardIndex).toBeGreaterThan(-1);
		expect(templateCardIndex).toBeGreaterThan(customThemeCardIndex);
		expect(source).toContain('class="custom-theme-list"');
		expect(source).toContain('class="custom-theme-swatch"');
		expect(source).toContain('{$LL.admin_theme_created_at()}');
		expect(source).toContain('{$LL.admin_theme_updated_at()}');
		expect(source).toContain('grid-template-columns: minmax(0, 1fr);');
	});

	it('publishes the radio-selected custom theme without list deletion or rollback controls', () => {
		const customThemeCardIndex = source.indexOf('class="settings-form-card custom-theme-card"');
		const templateCardIndex = source.indexOf('{$LL.admin_theme_templates_title()}');
		const customThemeCard = source.slice(customThemeCardIndex, templateCardIndex);

		expect(customThemeCard).toContain('type="radio"');
		expect(customThemeCard).toContain('name="theme-to-publish"');
		expect(customThemeCard).toContain('class="custom-theme-selection"');
		expect(customThemeCard).toContain('for={publishRadioId}');
		expect(customThemeCard).toContain('class="btn btn-secondary btn-sm custom-theme-edit"');
		expect(customThemeCard).toContain('onclick={() => openEditor(theme.id)}');
		expect(customThemeCard).toContain('onclick={publishSelectedTheme}');
		expect(customThemeCard).toContain('selectedPublishThemeId === activeCustomThemeId');
		expect(customThemeCard).not.toContain('custom-theme-delete');
		expect(source).toContain('active: selectedTheme.id');
		expect(source).toContain('buildPublishedThemeSettings(');
		expect(source).toContain('onclick={saveCustomTheme}');
		expect(source).not.toContain('Publish and rollback');
		expect(source).not.toContain('rollbackThemeSettings');
		expect(source).not.toContain("'login-ui.rollback_snapshot'");
		expect(source).not.toContain('saveAndApplyCustomTheme');
	});

	it('republishes live settings when the currently published custom theme is saved', () => {
		expect(source).toContain('if (activeCustomThemeId === updated.id)');
		expect(source).toContain('publishedThemeVersion + 1');
		expect(source).toContain(
			"'login-ui.published_snapshot': buildLoginUiSnapshot(selectedThemeSettings)"
		);
		expect(source).toContain("'login-ui.theme_template': theme.base");
	});

	it('uses dedicated high-contrast colors for the split brand panel preview', () => {
		expect(source).toContain('--preview-brand-panel-title-color: #f4f7ff;');
		expect(source).toContain('--preview-brand-panel-copy-color: #c7d2eb;');
		expect(source).toContain('color: var(--preview-brand-panel-title-color);');
		expect(source).toContain('color: var(--preview-brand-panel-copy-color);');
	});

	it('uses publish, edit, and published-state labels in both admin languages', () => {
		expect(enMessages).toContain("admin_theme_publish: 'Publish selected theme'");
		expect(enMessages).toContain("admin_theme_edit: 'Edit'");
		expect(enMessages).toContain("admin_theme_badge_active: 'Published'");
		expect(jaMessages).toContain("admin_theme_publish: '選択したテーマで公開する'");
		expect(jaMessages).toContain("admin_theme_edit: '編集'");
		expect(jaMessages).toContain("admin_theme_badge_active: '公開中'");
	});

	it('keeps explicit empty localized text instead of removing the override', () => {
		expect(source).toContain("localized[field] = value.trim() ? value : '';");
		expect(source).toContain('return getThemeTextOverride(locale, field) ?? fallback;');
		expect(source).not.toContain('placeholder={themeTextFallback');
	});
});
