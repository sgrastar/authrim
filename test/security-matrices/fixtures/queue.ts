import type { CallLedger } from './call-ledger';

/**
 * In-memory Queue fake. `send` records the message in the call ledger.
 */
export class MemoryQueue implements Queue<unknown> {
  constructor(
    private readonly ledger?: CallLedger,
    private readonly label = 'queue'
  ) {}

  async send(message: unknown): Promise<void> {
    this.ledger?.record('queue.send', this.label, message);
  }

  async sendBatch(messages: Iterable<MessageSendRequest<unknown>>): Promise<void> {
    for (const message of messages) {
      this.ledger?.record('queue.send', this.label, message.body);
    }
  }
}
