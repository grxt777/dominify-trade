import * as Sentry from '@sentry/node';
import type { Config } from '../config';

let enabled = false;

/** Sentry включается, только если задан SENTRY_DSN. Без него вызовы ниже ничего не делают. */
export function initMonitoring(cfg: Config, service: 'api' | 'bot' | 'worker') {
  if (!cfg.SENTRY_DSN || enabled) return;
  Sentry.init({
    dsn: cfg.SENTRY_DSN,
    environment: cfg.NODE_ENV,
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    initialScope: { tags: { service } },
  });
  enabled = true;
}

export function captureException(err: unknown, extra?: Record<string, unknown>) {
  if (!enabled) return;
  Sentry.captureException(err, extra ? { extra } : undefined);
}
