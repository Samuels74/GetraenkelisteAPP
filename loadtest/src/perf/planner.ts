/**
 * Planner statistics of the load-test database – fresh vs. production steady
 * state (see loadtest/support/zz_loadtest-routes.pb.js "planner-stats").
 *
 * PocketBase runs "PRAGMA optimize" by itself: daily at 00:00 UTC on the
 * write connection (core/base.go, cron job "__pbDBOptimize__") and after
 * every collection schema change (core/collection_record_table_sync.go). On
 * a new database the app tables are still empty when the migrations create
 * them, so sqlite_stat1 then only covers PocketBase's system tables; after
 * the first night with data it covers bookings, persons, users, … – with a
 * different plan for e.g. "Heute + nur meine" (idx_bookings_created instead
 * of idx_bookings_createdBy). Pooled read connections load statistics when
 * they are opened; PocketBase closes connections idle for 3 minutes, so after
 * a quiet night every connection plans with them.
 *
 * The load test measures that steady state: after seeding it runs exactly
 * the nightly statement and then makes every pooled connection reload the
 * schema. A1 additionally measures the list/totals variants before that, in
 * the state of a freshly seeded (or freshly migrated) database.
 */
import type PocketBase from 'pocketbase';

export type PlannerState = 'fresh' | 'steady';

export interface Stat1Row {
  tbl: string;
  idx: string;
  stat: string;
}

export interface PlannerInfo {
  state: PlannerState;
  /** ISO time of the optimize (steady state only). */
  optimizedAt?: string;
  /** Duration of "PRAGMA optimize" in ms. */
  optimizeMs?: number;
  /** App tables with statistics. */
  appTables: string[];
  stat1: Stat1Row[];
}

const PLANNER_ROUTE = '/api/loadtest/planner-stats';
const EXPLAIN_ROUTE = '/api/loadtest/explain';
const APP_TABLES = ['bookings', 'groups', 'offerings', 'persons', 'users'];

async function plannerAction(superuser: PocketBase, action: 'status' | 'optimize' | 'reload' | 'checkpoint') {
  return (await superuser.send(PLANNER_ROUTE, { method: 'POST', body: { action } })) as {
    durationMs: number;
    stat1: Stat1Row[];
  };
}

function info(state: PlannerState, stat1: Stat1Row[], extra: Partial<PlannerInfo> = {}): PlannerInfo {
  const appTables = [...new Set(stat1.map((row) => row.tbl).filter((tbl) => APP_TABLES.includes(tbl)))].sort();
  return { state, appTables, stat1, ...extra };
}

/** EXPLAIN QUERY PLAN of a SELECT (planned on the write connection, never executed). */
export async function explainPlan(superuser: PocketBase, sql: string, params: Record<string, string>): Promise<string[]> {
  const result = (await superuser.send(EXPLAIN_ROUTE, { method: 'POST', body: { sql, params } })) as { plan: string[] };
  return result.plan;
}

/** Tracks and switches the planner state of one instance. */
export class PlannerControl {
  private readonly superuser: () => Promise<PocketBase>;
  private current: PlannerInfo | null = null;
  private steady: Promise<PlannerInfo> | null = null;

  constructor(superuser: () => Promise<PocketBase>) {
    this.superuser = superuser;
  }

  get state(): PlannerState {
    return this.current?.state ?? 'fresh';
  }

  /** The current statistics (also records the fresh state on first use). */
  async status(): Promise<PlannerInfo> {
    const { stat1 } = await plannerAction(await this.superuser(), 'status');
    this.current = info(this.state, stat1, this.current ?? {});
    return this.current;
  }

  /**
   * "PRAGMA wal_checkpoint(TRUNCATE)" like PocketBase's nightly job (and its
   * backup): writes the WAL back into the database and empties it. A busy
   * scenario leaves tens of MiB of WAL behind (A3: 30–40 MiB); the runner
   * checkpoints before every scenario, so every scenario starts from the same
   * WAL state, whatever ran before it. Whether a large WAL slows later writes
   * was not established (A4's p99 varies between bursts either way).
   */
  async checkpoint(): Promise<number> {
    return (await plannerAction(await this.superuser(), 'checkpoint')).durationMs;
  }

  /** "PRAGMA optimize" like PocketBase's nightly job, then a schema reload on all connections. Idempotent. */
  ensureSteadyState(): Promise<PlannerInfo> {
    this.steady ??= (async () => {
      const superuser = await this.superuser();
      const optimizedAt = new Date().toISOString();
      const optimized = await plannerAction(superuser, 'optimize');
      await plannerAction(superuser, 'reload');
      this.current = info('steady', optimized.stat1, { optimizedAt, optimizeMs: optimized.durationMs });
      return this.current;
    })().catch((error: unknown) => {
      this.steady = null;
      throw error;
    });
    return this.steady;
  }
}
