/**
 * The environment banner's text for a viewer's language. Pure (no runtime dependencies), so the
 * Login UI and the Admin Console use the same rule as the services.
 */

/**
 * The text to show for a locale: the localized text (exact tag, else its language part), else
 * `text`. Empty when the banner is off or has nothing to say.
 */
export function environmentBannerText(
  banner: {
    text: string;
    textLocalizations: Readonly<Record<string, string>>;
    enabled?: boolean;
  },
  locale?: string | null
): string {
  if (banner.enabled === false) return '';
  const wanted = (locale ?? '').toLowerCase();
  if (wanted) {
    const localizations = banner.textLocalizations;
    const byTag = Object.keys(localizations).find((tag) => tag.toLowerCase() === wanted);
    const language = wanted.split('-')[0];
    const byLanguage = Object.keys(localizations).find((tag) => tag.toLowerCase() === language);
    const found = localizations[byTag ?? byLanguage ?? ''];
    if (found) return found;
  }
  return banner.text;
}
