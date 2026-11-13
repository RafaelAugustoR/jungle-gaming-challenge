export class InboxConflict extends Error {
  readonly code = 'INBOX_CONFLICT';
  constructor() {
    super('INBOX_CONFLICT');
    this.name = 'InboxConflict';
  }
}
