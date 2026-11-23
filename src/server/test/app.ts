import type { Config } from '../config';
import type { Db } from '../db/client';
import type { FxRates } from '../fx/fx-rates';
import { createApp, type App } from '../http/app';
import { createLogger } from '../logger';
import { testConfig } from './config';
import { FakeClock } from './fake-clock';
import { stubFx } from './fx';
import { TestClient } from './http-client';

export interface TestApp {
  db: Db;
  app: App;
  client: TestClient;
  clock: FakeClock;
  config: Config;
}

/** `fx` defaults to a stub without rates (every quote is null); pass `stubFx({ EUR: '4.3' })` to give it some. */
export function createTestApp(
  db: Db,
  options: { config?: Partial<Config>; now?: string; fx?: FxRates } = {},
): TestApp {
  const config = testConfig(options.config);
  const clock = new FakeClock(options.now ?? '2026-11-20T10:00:00Z');
  const app = createApp({
    db,
    config,
    clock,
    logger: createLogger(config.logLevel),
    fx: options.fx ?? stubFx(),
  });
  return { db, app, client: new TestClient(app), clock, config };
}
