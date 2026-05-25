export function extractAuthrimSessionIdFromCookieHeader(
  cookieHeader: string | null | undefined
): string | null {
  const rawSessionId = cookieHeader?.match(/(?:^|;\s*)authrim_session=([^;]+)/)?.[1];
  if (!rawSessionId) {
    return null;
  }

  try {
    return decodeURIComponent(rawSessionId);
  } catch {
    return rawSessionId;
  }
}
