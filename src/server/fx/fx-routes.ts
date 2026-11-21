import { Hono } from 'hono';
import { type FxRateDto, fxRateParamSchema } from '../../shared/api/fx';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import type { AppDeps } from '../http/app';
import { DomainError } from '../http/errors';
import { validate } from '../http/validate';

/** /api/fx (spec §9): NBP rates for the transaction sheet. */
export function fxRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/rates/:currency/:date', validate('param', fxRateParamSchema), async (c) => {
      const { currency, date } = c.req.valid('param');
      // NBP publishes nothing ahead; a future-dated transaction becomes a schedule and gets its rate when entered.
      const quote = date > today() ? null : await deps.fx.quote(currency, date);
      if (!quote) {
        throw new DomainError('fx_rate_unavailable', `There's no NBP rate for ${currency} on ${date}. Enter the rate.`);
      }
      return c.json<FxRateDto>(quote);
    });
}
