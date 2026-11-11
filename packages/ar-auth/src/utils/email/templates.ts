/**
 * Email Templates
 * HTML and plain text templates for authentication emails
 */

export interface EmailCodeTemplateData {
  name?: string;
  email: string;
  code: string;
  expiresInMinutes: number;
  appName: string;
  logoUrl?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeLogoUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Generate Email Code (OTP) email HTML
 * OTP AutoFill is handled via Authentication-Info header
 */
export function getEmailCodeHtml(data: EmailCodeTemplateData): string {
  const { name, email, code, expiresInMinutes, appName, logoUrl } = data;
  const htmlName = name ? escapeHtml(name) : '';
  const htmlEmail = escapeHtml(email);
  const htmlCode = escapeHtml(code);
  const htmlAppName = escapeHtml(appName);
  const htmlLogoUrl = safeLogoUrl(logoUrl);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your verification code for ${htmlAppName}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background-color: #f4f4f4;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 40px 20px;
      text-align: center;
      color: #ffffff;
    }
    .logo {
      max-width: 150px;
      height: auto;
      margin-bottom: 20px;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
    }
    .content {
      padding: 40px 30px;
    }
    .greeting {
      font-size: 18px;
      margin-bottom: 20px;
      color: #333;
    }
    .message {
      font-size: 16px;
      margin-bottom: 30px;
      color: #666;
    }
    .code-container {
      text-align: center;
      margin: 40px 0;
    }
    .code {
      display: inline-block;
      padding: 20px 40px;
      background-color: #f8f9fa;
      border: 2px dashed #667eea;
      border-radius: 8px;
      font-size: 36px;
      font-weight: bold;
      letter-spacing: 8px;
      color: #333;
      font-family: 'Courier New', Courier, monospace;
    }
    .warning {
      margin-top: 30px;
      padding: 15px;
      background-color: #fff3cd;
      border-left: 4px solid #ffc107;
      border-radius: 4px;
    }
    .warning-text {
      font-size: 14px;
      color: #856404;
      margin: 0;
    }
    .footer {
      background-color: #f8f9fa;
      padding: 30px;
      text-align: center;
      font-size: 14px;
      color: #666;
    }
    .footer a {
      color: #667eea;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${htmlLogoUrl ? `<img src="${escapeHtml(htmlLogoUrl)}" alt="${htmlAppName}" class="logo" />` : ''}
      <h1>Verification Code</h1>
    </div>
    <div class="content">
      <p class="greeting">Hello${htmlName ? ` ${htmlName}` : ''},</p>
      <p class="message">
        We received a request to sign in to your ${htmlAppName} account (${htmlEmail}). Use the verification code below:
      </p>
      <div class="code-container">
        <div class="code">${htmlCode}</div>
      </div>
      <div class="warning">
        <p class="warning-text">
          ⏱️ This code is valid for ${expiresInMinutes} minutes and can be used only once.
        </p>
      </div>
      <p class="message" style="margin-top: 30px; font-size: 14px;">
        If you didn't request this code, you can safely ignore this email. Someone may have entered your email address by mistake.
      </p>
    </div>
    <div class="footer">
      <p>This email was sent by ${htmlAppName}</p>
      <p>© ${new Date().getFullYear()} ${htmlAppName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate Email Code (OTP) email plain text
 * OTP AutoFill is handled via Authentication-Info header
 */
export function getEmailCodeText(data: EmailCodeTemplateData): string {
  const { name, email, code, expiresInMinutes, appName } = data;

  return `
Hello${name ? ` ${name}` : ''},

We received a request to sign in to your ${appName} account (${email}).

Your verification code is: ${code}

This code is valid for ${expiresInMinutes} minutes and can be used only once.

If you didn't request this code, you can safely ignore this email. Someone may have entered your email address by mistake.

---
This email was sent by ${appName}
© ${new Date().getFullYear()} ${appName}. All rights reserved.
  `.trim();
}

export interface AccountExistsTemplateData {
  email: string;
  appName: string;
}

/**
 * A sign-up for an address that already has an account (a registration Flow that answers as for
 * a new address, `duplicate: mail`): its owner is told, and how to go on. It carries no code or
 * link: whoever entered the address learns nothing from it.
 */
export function getAccountExistsHtml(data: AccountExistsTemplateData): string {
  const htmlEmail = escapeHtml(data.email);
  const htmlAppName = escapeHtml(data.appName);
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You already have an account with ${htmlAppName}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0;">
  <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; padding: 32px;">
    <h1 style="font-size: 20px; margin: 0 0 16px;">You already have an account</h1>
    <p>Someone tried to sign up to ${htmlAppName} with your email address (${htmlEmail}). It already has an account, so no new one was made.</p>
    <p>If it was you, sign in instead. If you have forgotten how you sign in, use the account recovery on the sign-in page.</p>
    <p>If it was not you, you can ignore this email: nothing was changed.</p>
  </div>
</body>
</html>
  `.trim();
}

export function getAccountExistsText(data: AccountExistsTemplateData): string {
  return `
Someone tried to sign up to ${data.appName} with your email address (${data.email}). It already has an account, so no new one was made.

If it was you, sign in instead. If you have forgotten how you sign in, use the account recovery on the sign-in page.

If it was not you, you can ignore this email: nothing was changed.

---
This email was sent by ${data.appName}
  `.trim();
}
