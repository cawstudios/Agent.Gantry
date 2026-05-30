import { describe, expect, it } from 'vitest';
import { buildOrderQueryClause } from '../../../src/tools/shared.js';

describe('buildOrderQueryClause', () => {
  it('routes BSS-style names to a name: query', () => {
    expect(buildOrderQueryClause('BSS-2847')).toEqual({
      query: 'name:BSS-2847',
      kind: 'name',
      needle: 'BSS-2847',
    });
  });

  it('strips a leading # from display names', () => {
    expect(buildOrderQueryClause('#1001')).toEqual({
      query: 'name:1001',
      kind: 'name',
      needle: '1001',
    });
  });

  it('treats short numeric input as a display name', () => {
    expect(buildOrderQueryClause('1001')).toEqual({
      query: 'name:1001',
      kind: 'name',
      needle: '1001',
    });
  });

  it('uses id: query for >=10-digit numeric IDs', () => {
    expect(buildOrderQueryClause('7057409966300')).toEqual({
      query: 'id:7057409966300',
      kind: 'numeric_id',
      needle: 'gid://shopify/Order/7057409966300',
    });
  });

  it('strips the gid:// prefix and queries by numeric id', () => {
    expect(
      buildOrderQueryClause('gid://shopify/Order/7057409966300'),
    ).toEqual({
      query: 'id:7057409966300',
      kind: 'numeric_id',
      needle: 'gid://shopify/Order/7057409966300',
    });
  });

  it('falls back to name: for malformed GIDs', () => {
    expect(
      buildOrderQueryClause('gid://shopify/Order/not-a-number'),
    ).toMatchObject({ kind: 'name' });
  });

  it('trims whitespace before classifying', () => {
    expect(buildOrderQueryClause('  BSS-2847  ').needle).toBe('BSS-2847');
    expect(buildOrderQueryClause('  7057409966300  ').query).toBe(
      'id:7057409966300',
    );
  });
});
