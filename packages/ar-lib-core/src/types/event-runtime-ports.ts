import type {
  EventPublishOptions,
  EventPublishPayload,
  EventPublishResult,
} from './events/dispatcher';

/** Deployment-owned event delivery for a limited alternate runtime. */
export interface EventRuntimePorts {
  publish<T = unknown>(
    payload: EventPublishPayload<T>,
    options?: EventPublishOptions
  ): Promise<EventPublishResult>;
}
