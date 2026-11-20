import type { Logger } from '../logger';

/** Hono context variables shared by every route. */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
  };
}
