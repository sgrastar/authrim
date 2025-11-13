/**
 * Resend Email Provider
 * Implementation of IEmailProvider using Resend API
 */

import { Resend } from 'resend';
import type { IEmailProvider, EmailMessage, EmailSendResult } from './interfaces';

export class ResendEmailProvider implements IEmailProvider {
  private resend: Resend;

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const { data, error } = await this.resend.emails.send({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });

      if (error) {
        console.error('Resend email error:', error);
        return {
          success: false,
          error: error.message || 'Failed to send email',
        };
      }

      return {
        success: true,
        messageId: data?.id,
      };
    } catch (error) {
      console.error('Resend email exception:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
