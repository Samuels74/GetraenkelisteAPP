/**
 * A9 – logins and the login rate limiter (shift start, typos).
 *
 * (a) Logins of admin + user1 … user5, sequentially and all at once – bcrypt
 *     makes a login cost ≈ 45 ms of CPU.
 * (b) The app's rate limiter (migration 1790550002: rule "*:auth", 10 logins
 *     per 60 s per client IP) switched on, as in production: 12 logins in a
 *     row from one IP must be answered 10 × OK and then HTTP 429.
 *
 * PocketBase keys the limiter by the client IP (apis/middlewares_rate_limit.go,
 * a fixed window started by the first attempt). Behind a reverse proxy
 * without the trusted-proxy header, or with all phones behind one NAT
 * address, the whole bar shares these 10 logins per minute
 * (deploy/reverse-proxy.md "Client IP").
 *
 * Runs last: it leaves the limiter on (the instance is discarded afterwards).
 */
import { latencyStats } from '../../stats.ts';
import { describeLatency } from '../analysis.ts';
import { DEFAULT_PASSWORD } from '../../dataset.ts';
import { HttpClient } from '../http.ts';
import { paths } from '../requests.ts';
import { runScenario, type PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';

export async function scenarioA9(ctx: PerfContext): Promise<ScenarioResult[]> {
  const result = await runScenario(
    ctx,
    {
      id: 'A9',
      title: 'Logins and the login rate limiter',
      simulates: 'the shift starts: everybody logs in; then someone keeps mistyping (rate limiter on, as in production)',
    },
    async (rec) => {
      const accounts = ['admin', 'user1', 'user2', 'user3', 'user4', 'user5'];
      const client = new HttpClient(ctx.url, { maxSockets: accounts.length });
      try {
        const login = (identity: string) => client.post(paths.login(), { identity, password: DEFAULT_PASSWORD });
        const sequential: number[] = [];
        const concurrent: number[] = [];
        const failures: string[] = [];
        const window = rec.window();
        for (let round = 0; round < 2; round++) {
          for (const account of accounts) {
            const result = await login(account);
            sequential.push(result.ms);
            if (result.status !== 200) failures.push(`${account}: ${result.error}`);
          }
          const results = await Promise.all(accounts.map((account) => login(account)));
          for (const [i, result] of results.entries()) {
            concurrent.push(result.ms);
            if (result.status !== 200) failures.push(`${accounts[i]}: ${result.error}`);
          }
        }
        window.stop();
        const all = latencyStats([...sequential, ...concurrent]);
        rec.add({
          key: 'login.p95',
          label: 'login (auth-with-password) – p95, one by one and 6 at once',
          value: all.count ? all.p95 : null,
          unit: 'ms',
          budget: { direction: 'max', warn: 200, fail: 1000, rationale: 'bcrypt ≈ 45 ms per login; > 1 s at shift start feels broken' },
          detail: `sequential ${describeLatency(latencyStats(sequential))}; 6 at once ${describeLatency(latencyStats(concurrent))}`,
        });
        rec.add({
          key: 'login.errors',
          label: 'failed logins (correct passwords)',
          value: failures.length,
          unit: 'count',
          budget: { direction: 'max', fail: 0, rationale: 'correct credentials must always work (limiter off)' },
          detail: failures.slice(0, 3).join('; ') || 'none',
        });

        // (b) the limiter as in production
        await ctx.instance.setRateLimiting(true);
        const statuses: number[] = [];
        for (let attempt = 1; attempt <= 12; attempt++) statuses.push((await login('user1')).status);
        const first429 = statuses.indexOf(429) + 1;
        // the rule must hold exactly: 10 logins accepted, the 11th refused (a fresh window – switching the
        // limiter on reloads the settings, which resets PocketBase's limiter store)
        rec.add({
          key: 'ratelimit.accepted',
          label: 'login rate limiter – logins accepted before the first HTTP 429',
          value: first429 > 0 ? first429 - 1 : statuses.length,
          unit: 'count',
          budget: { direction: 'min', fail: 10, rationale: 'rule "*:auth" allows 10 logins per 60 s per IP: attempts 1–10 must pass' },
          detail: `statuses of 12 attempts: ${statuses.join(' ')}`,
          explain: (verdict) => (verdict === 'fail' ? 'the limiter refuses logins earlier than configured – staff are locked out too soon' : undefined),
        });
        rec.add({
          key: 'ratelimit.first429',
          label: 'login rate limiter – first HTTP 429 at attempt',
          value: first429 > 0 ? first429 : null,
          unit: 'count',
          budget: { direction: 'max', fail: 11, rationale: 'the 11th login within 60 s from one IP must be refused (none = no brute-force protection)' },
          detail: first429 > 0 ? `exactly 11 expected` : 'no attempt was refused',
          explain: (verdict) =>
            verdict === 'fail'
              ? first429 > 0
                ? 'the limiter refuses later than configured – more password guesses per minute get through'
                : 'the limiter did not refuse any login – brute-force protection is not active'
              : undefined,
        });
        rec.note(
          'The limit counts per client IP: if the reverse proxy does not pass the client address (trusted proxy header) – or all phones ' +
            'reach the server through one NAT address – the whole bar shares 10 logins per minute; the 11th person sees "too many requests".',
        );
        rec.data.statuses = statuses;
      } finally {
        client.close();
      }
    },
  );
  return [result];
}
