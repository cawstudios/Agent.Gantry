import { nowIso as currentIso } from '../shared/time/datetime.js';

type ThreadFilterSqlOps = {
  eq: (left: any, right: any) => any;
  isNull: (value: any) => any;
};

export function nowIso(): string {
  return currentIso();
}

export function createSqlThreadIdentityFilter(sqlOps: ThreadFilterSqlOps) {
  return (i: { threadId: any }, threadId: string | undefined): any =>
    threadId
      ? sqlOps.eq(i.threadId as any, threadId)
      : sqlOps.isNull(i.threadId as any);
}

export async function withStatementTimeout<T>(
  db: any,
  timeoutMs: number | undefined,
  statementTimeoutSql: (timeoutMs: number) => unknown,
  work: (db: any) => Promise<T>,
): Promise<T> {
  const boundedTimeoutMs = normalizeStatementTimeoutMs(timeoutMs);
  if (boundedTimeoutMs === undefined) {
    return work(db);
  }
  return db.transaction(async (tx: any) => {
    await tx.execute(statementTimeoutSql(boundedTimeoutMs));
    return work(tx);
  });
}

function normalizeStatementTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return undefined;
  return Math.max(1, Math.floor(timeoutMs));
}
