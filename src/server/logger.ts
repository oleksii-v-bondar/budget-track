import { pino, type Logger } from 'pino';
import type { LogLevel } from './config';

export type { Logger };

/** JSON logs to stdout (spec §13). */
export function createLogger(level: LogLevel): Logger {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
}
