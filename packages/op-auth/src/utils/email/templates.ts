/**
 * Email Templates
 * HTML and plain text templates for authentication emails
 */

export interface MagicLinkTemplateData {
  name?: string;
  email: string;
  magicLink: string;
  expiresInMinutes: number;
  appName: string;
  logoUrl?: string;
}

/**
 * Generate Magic Link email HTML
 */
export function getMagicLinkEmailHtml(data: MagicLinkTemplateData): string {
  const { name, email, magicLink, expiresInMinutes, appName, logoUrl } = data;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to ${appName}</title>
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
    .button-container {
      text-align: center;
      margin: 40px 0;
    }
    .button {
      display: inline-block;
      padding: 14px 40px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #ffffff;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 16px;
      transition: transform 0.2s;
    }
    .button:hover {
      transform: translateY(-2px);
    }
    .link-container {
      margin-top: 30px;
      padding: 20px;
      background-color: #f8f9fa;
      border-radius: 6px;
      border-left: 4px solid #667eea;
    }
    .link-label {
      font-size: 14px;
      color: #666;
      margin-bottom: 10px;
    }
    .link-url {
      font-size: 12px;
      color: #667eea;
      word-break: break-all;
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
      ${logoUrl ? `<img src="${logoUrl}" alt="${appName}" class="logo" />` : ''}
      <h1>Sign in to ${appName}</h1>
    </div>
    <div class="content">
      <p class="greeting">Hello${name ? ` ${name}` : ''},</p>
      <p class="message">
        We received a request to sign in to your ${appName} account (${email}). Click the button below to securely sign in:
      </p>
      <div class="button-container">
        <a href="${magicLink}" class="button">Sign in to ${appName}</a>
      </div>
      <div class="link-container">
        <p class="link-label">Or copy and paste this link into your browser:</p>
        <p class="link-url">${magicLink}</p>
      </div>
      <div class="warning">
        <p class="warning-text">
          ⏱️ This link will expire in ${expiresInMinutes} minutes for security reasons.
        </p>
      </div>
      <p class="message" style="margin-top: 30px; font-size: 14px;">
        If you didn't request this email, you can safely ignore it. Someone may have entered your email address by mistake.
      </p>
    </div>
    <div class="footer">
      <p>This email was sent by ${appName}</p>
      <p>© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate Magic Link email plain text
 */
export function getMagicLinkEmailText(data: MagicLinkTemplateData): string {
  const { name, email, magicLink, expiresInMinutes, appName } = data;

  return `
Hello${name ? ` ${name}` : ''},

We received a request to sign in to your ${appName} account (${email}).

Click the link below to securely sign in:
${magicLink}

This link will expire in ${expiresInMinutes} minutes for security reasons.

If you didn't request this email, you can safely ignore it. Someone may have entered your email address by mistake.

---
This email was sent by ${appName}
© ${new Date().getFullYear()} ${appName}. All rights reserved.
  `.trim();
}
