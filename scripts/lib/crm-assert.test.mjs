import { describe, it, expect } from 'vitest';
import { evaluateCrm } from './crm-assert.mjs';

const req = (toolName, args = {}) => ({
  flow: 'mcp.request',
  serverName: 'boondi-crm',
  toolName,
  arguments: args,
});
const resp = (toolName, payload) => ({
  flow: 'mcp.response',
  serverName: 'boondi-crm',
  toolName,
  result: { content: [{ text: JSON.stringify(payload) }], isError: false },
});

describe('evaluateCrm', () => {
  it('passes when expected record_query call present with intentCategory', () => {
    expect(
      evaluateCrm([req('record_query', { intentCategory: 'gifting_b2b', occasion: 'Diwali' })], {
        crm: { tool: 'record_query', intentCategory: 'gifting_b2b' },
      }),
    ).toEqual([]);
  });
  it('fails when the expected capture call is missing', () => {
    const f = evaluateCrm(
      [{ flow: 'mcp.request', serverName: 'shopify-api', toolName: 'get_order', arguments: {} }],
      { crm: { tool: 'record_query' } },
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/expected a boondi-crm "record_query" call/);
  });
  it('crmNone passes when only a read (get_open_records) occurred', () => {
    expect(evaluateCrm([req('get_open_records', {})], { crmNone: true })).toEqual([]);
  });
  it('crmNone fails when a write capture slipped through', () => {
    expect(
      evaluateCrm([req('record_query', { intentCategory: 'shopping' })], { crmNone: true })[0],
    ).toMatch(/expected no capture/);
  });
  it('verifies upgrade_to_lead response status/score/band', () => {
    const ev = [
      req('upgrade_to_lead', { quantity: 300 }),
      resp('upgrade_to_lead', { ok: true, status: 'lead', score: 77, band: 'P2' }),
    ];
    expect(
      evaluateCrm(ev, { crm: { tool: 'upgrade_to_lead', status: 'lead', expectScored: true, band: 'P2' } }),
    ).toEqual([]);
  });
  it('flags wrong intentCategory', () => {
    expect(
      evaluateCrm([req('record_query', { intentCategory: 'shopping' })], {
        crm: { tool: 'record_query', intentCategory: 'corporate' },
      })[0],
    ).toMatch(/intentCategory expected "corporate"/);
  });
  it('checks argsMustInclude presence and value', () => {
    const ev = [req('update_record', { budgetPerGiftInr: 1500 })];
    expect(
      evaluateCrm(ev, { crm: { tool: 'update_record', argsMustInclude: { budgetPerGiftInr: true } } }),
    ).toEqual([]);
    expect(
      evaluateCrm(ev, { crm: { tool: 'update_record', argsMustInclude: { timelineDays: true } } })[0],
    ).toMatch(/arg "timelineDays" expected present/);
  });
});
