import type {
  AgentEventStorePort,
  AgentProtocolEvent,
  AgentScheduledJob,
  AgentSchedulerPort,
  AgentSessionRecord,
  AgentSessionStorePort,
} from '../ports';

const SESSION_PREFIX = 'agent-access:session:';
const EVENT_PREFIX = 'agent-access:event:';
const EVENT_INDEX_PREFIX = 'agent-access:event-index:';
const JOB_PREFIX = 'agent-access:job:';

function eventKey(event: AgentProtocolEvent): string {
  return `${EVENT_PREFIX}${event.sessionId}:${String(event.createdAt).padStart(16, '0')}:${event.id}`;
}

export class CloudflareDurableObjectSessionStore implements AgentSessionStorePort {
  constructor(private readonly storage: DurableObjectStorage) {}

  async get(sessionId: string): Promise<AgentSessionRecord | null> {
    return (await this.storage.get<AgentSessionRecord>(`${SESSION_PREFIX}${sessionId}`)) ?? null;
  }

  async put(record: AgentSessionRecord): Promise<void> {
    await this.storage.put(`${SESSION_PREFIX}${record.id}`, record);
  }

  async touch(sessionId: string, lastActiveAt: number): Promise<boolean> {
    const record = await this.get(sessionId);
    if (!record) return false;
    await this.put({ ...record, lastActiveAt });
    return true;
  }

  async delete(sessionId: string): Promise<void> {
    await this.storage.delete(`${SESSION_PREFIX}${sessionId}`);
  }
}

export class CloudflareDurableObjectEventStore implements AgentEventStorePort {
  constructor(private readonly storage: DurableObjectStorage) {}

  async append(event: AgentProtocolEvent): Promise<void> {
    await this.storage.put({
      [eventKey(event)]: event,
      [`${EVENT_INDEX_PREFIX}${event.sessionId}:${event.id}`]: eventKey(event),
    });
  }

  async listAfter(
    sessionId: string,
    lastEventId: string | undefined
  ): Promise<AgentProtocolEvent[]> {
    const events = Array.from(
      (
        await this.storage.list<AgentProtocolEvent>({
          prefix: `${EVENT_PREFIX}${sessionId}:`,
        })
      ).values()
    );
    if (!lastEventId) return events;
    const position = events.findIndex((event) => event.id === lastEventId);
    return position < 0 ? [] : events.slice(position + 1);
  }

  async purgeSession(sessionId: string): Promise<void> {
    const events = await this.storage.list<AgentProtocolEvent>({
      prefix: `${EVENT_PREFIX}${sessionId}:`,
    });
    const indexes = await this.storage.list<string>({
      prefix: `${EVENT_INDEX_PREFIX}${sessionId}:`,
    });
    await this.storage.delete([...events.keys(), ...indexes.keys()]);
  }
}

/**
 * Persists arbitrary scheduled jobs in the session DO. The owning Durable Object's alarm handler
 * calls takeDueJobs(); job execution remains an injected application concern.
 */
export class CloudflareDurableObjectScheduler implements AgentSchedulerPort {
  constructor(private readonly storage: DurableObjectStorage) {}

  async schedule(job: AgentScheduledJob): Promise<void> {
    await this.storage.put(`${JOB_PREFIX}${job.id}`, job);
    await this.armEarliestAlarm();
  }

  async cancel(jobId: string): Promise<void> {
    await this.storage.delete(`${JOB_PREFIX}${jobId}`);
    await this.armEarliestAlarm();
  }

  async takeDueJobs(now: number): Promise<AgentScheduledJob[]> {
    const entries = await this.storage.list<AgentScheduledJob>({ prefix: JOB_PREFIX });
    const due = Array.from(entries.entries()).filter(([, job]) => job.runAt <= now);
    if (due.length > 0) await this.storage.delete(due.map(([key]) => key));
    await this.armEarliestAlarm();
    return due.map(([, job]) => job);
  }

  private async armEarliestAlarm(): Promise<void> {
    const jobs = Array.from(
      (await this.storage.list<AgentScheduledJob>({ prefix: JOB_PREFIX })).values()
    );
    if (jobs.length === 0) {
      await this.storage.deleteAlarm();
      return;
    }
    await this.storage.setAlarm(Math.min(...jobs.map((job) => job.runAt)));
  }
}
