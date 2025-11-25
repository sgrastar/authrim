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
  domain: string;
  logoUrl?: string;
}

/**
 * Generate Email Code (OTP) email HTML
 * Safari autofill compatible with @domain #code format
 */
export function getEmailCodeHtml(data: EmailCodeTemplateData): string {
  const { name, email, code, expiresInMinutes, appName, domain, logoUrl } = data;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your verification code for ${appName}</title>
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
    .autofill-hint {
      margin-top: 20px;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${logoUrl ? `<img src="${logoUrl}" alt="${appName}" class="logo" />` : ''}
      <h1>Verification Code</h1>
    </div>
    <div class="content">
      <p class="greeting">Hello${name ? ` ${name}` : ''},</p>
      <p class="message">
        We received a request to sign in to your ${appName} account (${email}). Use the verification code below:
      </p>
      <div class="code-container">
        <div class="code">${code}</div>
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
      <p>This email was sent by ${appName}</p>
      <p>© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
      <p class="autofill-hint">@${domain} #${code}</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate Email Code (OTP) email plain text
 * Safari autofill compatible with @domain #code format at the end
 */
export function getEmailCodeText(data: EmailCodeTemplateData): string {
  const { name, email, code, expiresInMinutes, appName, domain } = data;

  return `
Hello${name ? ` ${name}` : ''},

We received a request to sign in to your ${appName} account (${email}).

Your verification code is: ${code}

This code is valid for ${expiresInMinutes} minutes and can be used only once.

If you didn't request this code, you can safely ignore this email. Someone may have entered your email address by mistake.

---
This email was sent by ${appName}
© ${new Date().getFullYear()} ${appName}. All rights reserved.

@${domain} #${code}
  `.trim();
}
