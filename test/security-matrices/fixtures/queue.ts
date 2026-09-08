import type { CallLedger } from './call-ledger';

/**
 * In-memory Queue fake. `send` records the message in the call ledger.
 */
export class MemoryQueue implements Queue<unknown> {
  constructor(
    private readonly ledger?: CallLedger,
    private readonly label = 'queue'
  ) {}

  async metrics(): Promise<QueueMetrics> {
    return { backlogCount: 0, backlogBytes: 0 };
  }

  async send(message: unknown, _options?: QueueSendOptions): Promise<QueueSendResponse> {
    this.ledger?.record('queue.send', this.label, message);
    return { metadata: { metrics: await this.metrics() } };
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<unknown>>,
    _options?: QueueSendBatchOptions
  ): Promise<QueueSendBatchResponse> {
    for (const message of messages) {
      this.ledger?.record('queue.send', this.label, message.body);
    }
    return { metadata: { metrics: await this.metrics() } };
  }
}
