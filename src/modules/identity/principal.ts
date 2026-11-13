export type Principal =
  | { kind: 'human'; subject: string; roles: string[] }
  | { kind: 'provider'; subject: string; providerId: string };
