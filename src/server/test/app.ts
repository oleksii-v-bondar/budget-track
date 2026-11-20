import type { Config } from '../config';
import type { Db } from '../db/client';
import { createApp, type App } from '../http/app';
import { clientIpResolver } from '../http/client-ip';
import { createLogger } from '../logger';
import { testConfig } from './config';
import { FakeClock } from './fake-clock';
import { TestClient } from './http-client';

export interface TestApp {
  app: App;
  client: TestClient;
  clock: FakeClock;
  config: Config;
}

export function createTestApp(db: Db, options: { config?: Partial<Config>; now?: string } = {}): TestApp {
  const config = testConfig(options.config);
  const clock = new FakeClock(options.now ?? '2026-11-20T10:00:00Z');
  const app = createApp({
    db,
    config,
    clock,
    logger: createLogger(config.logLevel),
    clientIp: clientIpResolver(config.trustProxy),
  });
  return { app, client: new TestClient(app), clock, config };
}
