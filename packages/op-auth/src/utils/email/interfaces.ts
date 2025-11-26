/**
 * Email Provider Interface
 * Defines the contract for email providers (Resend, SMTP, Cloudflare Email, etc.)
 */

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface IEmailProvider {
  /**
   * Send an email
   * @param message Email message to send
   * @returns Result of the email send operation
   */
  send(message: EmailMessage): Promise<EmailSendResult>;
}
