export interface EventContext {
  correlationId: string;
  causationId?: string;
}
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId = crypto.randomUUID();
  protected constructor(
    readonly aggregateId: string,
    private readonly occurredAt: string,
    private readonly context: EventContext,
    readonly data: Readonly<T>,
  ) {}
  toJSON() {
    return {
      eventId: this.eventId,
      aggregateId: this.aggregateId,
      ...this.context,
      occurredAt: this.occurredAt,
      eventType: this.eventType,
      version: this.version,
      data: this.data,
    };
  }
}
