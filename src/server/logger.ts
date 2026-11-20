import { type DestinationStream, pino, type Logger } from 'pino';
import type { LogLevel } from './config';

export type { Logger };

interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: SerializedError;
}

const QUERY_ERROR_PREFIX = 'Failed query:';
/** Guards against cyclic `cause` chains. */
const MAX_CAUSE_DEPTH = 5;

/** Drizzle's query errors read "Failed query: <sql>\nparams: <values>"; only the first line of the SQL is kept. */
function safeMessage(message: string): string {
  return message.startsWith(QUERY_ERROR_PREFIX) ? message.split('\n', 1)[0]! : message;
}

/** The top-level error keeps its stack; causes keep only their type, message and code. */
function serialize(err: unknown, depth: number): SerializedError {
  if (typeof err !== 'object' || err === null) return { type: typeof err, message: safeMessage(String(err)) };
  const fields = err as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; cause?: unknown };
  const type = err.constructor?.name || (typeof fields.name === 'string' ? fields.name : 'Error');
  const message = safeMessage(typeof fields.message === 'string' ? fields.message : String(fields.message ?? ''));
  const serialized: SerializedError = { type, message };
  if (depth === 0 && typeof fields.stack === 'string') {
    // Rebuilt from the frames: the stack's first lines repeat the original message, query parameters included.
    const frames = fields.stack.split('\n').filter((line) => /^\s+at /.test(line));
    serialized.stack = [`${type}: ${message}`, ...frames].join('\n');
  }
  if (typeof fields.code === 'string' || typeof fields.code === 'number') serialized.code = fields.code;
  if (fields.cause !== undefined && depth < MAX_CAUSE_DEPTH) serialized.cause = serialize(fields.cause, depth + 1);
  return serialized;
}

/**
 * pino's `err` serializer, without anything that can carry user data: other properties (Drizzle's `params`, the
 * driver's `detail`) are dropped and query parameters are cut from the message and stack.
 */
export function safeErrSerializer(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? serialize(err, 0) : err;
}

/** JSON logs to stdout (spec §13), or to `destination` in tests. */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: safeErrSerializer },
  };
  return destination ? pino(options, destination) : pino(options);
}
