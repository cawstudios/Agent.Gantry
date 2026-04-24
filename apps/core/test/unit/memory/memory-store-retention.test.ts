import { describe, expect, it, vi } from 'vitest';

import { MEMORY_MAX_PROCEDURES_PER_GROUP } from '../../../src/config/index.js';
import { MemoryStore } from '../../../src/memory/persistence/store.js';

class QueryMock {
  private orderArgs: unknown[] = [];

  constructor(
    private readonly rows:
      | unknown[]
      | ((query: QueryMock, limitValue?: number) => unknown[]),
  ) {}

  from(): this {
    return this;
  }

  where(): this {
    return this;
  }

  orderBy(...args: unknown[]): this {
    this.orderArgs = args;
    return this;
  }

  offset(): Promise<unknown[]> {
    return Promise.resolve(this.resolveRows());
  }

  limit(limitValue: number): Promise<unknown[]> {
    return Promise.resolve(this.resolveRows(limitValue));
  }

  returning(): Promise<unknown[]> {
    return Promise.resolve(this.resolveRows());
  }

  set(): this {
    return this;
  }

  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.resolveRows()).then(onfulfilled, onrejected);
  }

  private resolveRows(limitValue?: number): unknown[] {
    if (Array.isArray(this.rows)) return this.rows;
    return this.rows(this, limitValue);
  }

  hasAscendingOrder(): boolean {
    return this.orderArgs.every((arg) => {
      const chunks = (arg as { queryChunks?: Array<{ value?: string[] }> })
        .queryChunks;
      return chunks?.some((chunk) => chunk.value?.includes(' asc')) ?? false;
    });
  }
}

describe('MemoryStore retention', () => {
  it('evicts lowest-value procedure overflow rows first', async () => {
    let selectCall = 0;
    const db = {
      delete: vi.fn(() => new QueryMock([])),
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) return new QueryMock([]);
        if (selectCall === 2) return new QueryMock([{ total: 0 }]);
        if (selectCall === 3) return new QueryMock([]);
        if (selectCall === 4) {
          return new QueryMock([
            { total: MEMORY_MAX_PROCEDURES_PER_GROUP + 2 },
          ]);
        }
        if (selectCall === 5) {
          return new QueryMock((query, limitValue) => {
            expect(query.hasAscendingOrder()).toBe(true);
            expect(limitValue).toBe(2);
            return [
              { id: 'procedure-low-confidence' },
              { id: 'procedure-old-low-confidence' },
            ];
          });
        }
        return new QueryMock([]);
      }),
      update: vi.fn(() => new QueryMock([])),
    };
    const store = new MemoryStore(db as never);
    const softDeleteProcedure = vi
      .spyOn(store, 'softDeleteProcedure')
      .mockResolvedValue();

    const result = await store.applyRetentionPolicies('team');

    expect(softDeleteProcedure).toHaveBeenCalledWith(
      'procedure-low-confidence',
    );
    expect(softDeleteProcedure).toHaveBeenCalledWith(
      'procedure-old-low-confidence',
    );
    expect(result.removedProcedureIds).toEqual([
      'procedure-low-confidence',
      'procedure-old-low-confidence',
    ]);
  });
});