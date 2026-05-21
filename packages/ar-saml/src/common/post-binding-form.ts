export interface SAMLPostBindingField {
  name: string;
  value: string;
}

export interface SAMLPostBindingResponseOptions {
  title: string;
  actionUrl: string;
  fields: SAMLPostBindingField[];
  buttonText: string;
  additionalHeaders?: Record<string, string>;
}

export function buildSAMLPostBindingResponse(options: SAMLPostBindingResponseOptions): Response {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const formActionOrigin = new URL(options.actionUrl).origin;
  const fieldsHtml = options.fields
    .map(
      (field) =>
        `<input type="hidden" name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}" />`
    )
    .join('\n    ');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(options.title)}</title>
</head>
<body>
  <noscript>
    <p>JavaScript is disabled. Click the button to continue.</p>
  </noscript>
  <form id="saml-post-binding" method="POST" action="${escapeHtml(options.actionUrl)}">
    ${fieldsHtml}
    <noscript>
      <button type="submit">${escapeHtml(options.buttonText)}</button>
    </noscript>
  </form>
  <script nonce="${nonce}">
    document.getElementById('saml-post-binding').submit();
  </script>
</body>
</html>
`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'none'",
        "img-src 'none'",
        "connect-src 'none'",
        `form-action ${formActionOrigin}`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      ...(options.additionalHeaders ?? {}),
    },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
