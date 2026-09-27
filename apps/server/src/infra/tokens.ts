export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
export const DB_POOL = Symbol('DB_POOL');
export const REDIS = Symbol('REDIS');

export const QUEUE_NAMES = {
  parse: 'parse',
  matching: 'matching',
  notify: 'notify',
  scheduled: 'scheduled',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
