import { describe, expect, it } from 'vitest';
import {
  bandForScore,
  deriveContactQuality,
  scoreBudget,
  scoreBuyerType,
  scoreContactQuality,
  scoreCustomisation,
  scoreDelivery,
  scoreLead,
  scoreQuantity,
  scoreTimeline,
} from '../src/scoring.js';

// Every point value below is asserted against the Orchestration Blueprint v3
// tables (the source of truth). If a bucket changes, these tests must change
// with the doc — not silently.

describe('dimension A — quantity (max 25)', () => {
  it.each([
    [5, 0],
    [24, 0],
    [25, 10],
    [100, 10],
    [101, 18],
    [300, 18],
    [301, 22],
    [1000, 22],
    [1001, 25],
    [5000, 25],
  ])('quantity %i -> %i', (qty, pts) => {
    expect(scoreQuantity(qty)).toBe(pts);
  });
  it('unknown quantity -> 0', () => expect(scoreQuantity(undefined)).toBe(0));
});

describe('dimension B — budget per gift (max 20)', () => {
  it.each([
    [300, 5],
    [499, 5],
    [500, 10],
    [999, 10],
    [1000, 16],
    [2000, 16],
    [2001, 20],
    [5000, 20],
  ])('₹%i/gift -> %i', (inr, pts) => {
    expect(scoreBudget({ budgetPerGiftInr: inr })).toBe(pts);
  });
  it('undecided -> 8', () =>
    expect(scoreBudget({ budgetUndecided: true })).toBe(8));
  it('unknown -> 0', () => expect(scoreBudget({})).toBe(0));
});

describe('dimension C — buyer type (max 15)', () => {
  it.each([
    ['personal', 2],
    ['wedding_event', 6],
    ['small_business', 10],
    ['employee_gifting', 12],
    ['client_vip_procurement', 15],
  ] as const)('%s -> %i', (t, pts) => {
    expect(scoreBuyerType(t)).toBe(pts);
  });
  it('unknown -> 0', () => expect(scoreBuyerType(undefined)).toBe(0));
});

describe('dimension D — customisation (max 15)', () => {
  it.each([
    ['none', 2],
    ['note_card', 5],
    ['logo', 10],
    ['custom_packaging', 13],
    ['bespoke', 15],
  ] as const)('%s -> %i', (c, pts) => {
    expect(scoreCustomisation(c)).toBe(pts);
  });
});

describe('dimension E — delivery scope (max 10)', () => {
  it.each([
    ['single', 3],
    ['multi_drop_city', 5],
    ['multi_city', 8],
    ['pan_india', 10],
  ] as const)('%s -> %i', (s, pts) => {
    expect(scoreDelivery(s)).toBe(pts);
  });
});

describe('dimension F — timeline (max 10)', () => {
  it.each([
    [3, 10],
    [7, 10],
    [8, 8],
    [21, 8],
    [22, 5],
    [60, 5],
  ])('%i days -> %i', (days, pts) => {
    expect(scoreTimeline({ timelineDays: days })).toBe(pts);
  });
  it('just exploring -> 2', () =>
    expect(scoreTimeline({ timelineExploring: true })).toBe(2));
  it('unknown -> 0', () => expect(scoreTimeline({})).toBe(0));
});

describe('dimension G — contact quality (max 5)', () => {
  it.each([
    ['name_only', 1],
    ['phone', 2],
    ['email_phone', 3],
    ['corporate_email', 5],
  ] as const)('%s -> %i', (c, pts) => {
    expect(scoreContactQuality(c)).toBe(pts);
  });
});

describe('band thresholds (Blueprint)', () => {
  it.each([
    [0, 'P5'],
    [24, 'P5'],
    [25, 'P4'],
    [49, 'P4'],
    [50, 'P3'],
    [69, 'P3'],
    [70, 'P2'],
    [84, 'P2'],
    [85, 'P1'],
    [100, 'P1'],
  ] as const)('score %i -> %s', (score, band) => {
    expect(bandForScore(score)).toBe(band);
  });
});

describe('scoreLead — end to end', () => {
  it('worked corporate-Diwali case = 77 (P2)', () => {
    const result = scoreLead({
      quantity: 300, // 18
      budgetPerGiftInr: 1500, // 16
      buyerType: 'employee_gifting', // 12
      customisation: 'logo', // 10
      locationScope: 'multi_city', // 8
      timelineDays: 10, // 8
      contactQuality: 'corporate_email', // 5
    });
    expect(result.breakdown).toEqual({
      quantity: 18,
      budget: 16,
      buyerType: 12,
      customisation: 10,
      delivery: 8,
      timeline: 8,
      contactQuality: 5,
    });
    expect(result.score).toBe(77);
    expect(result.band).toBe('P2');
  });

  it('all unknown -> 0 (P5)', () => {
    const result = scoreLead({});
    expect(result.score).toBe(0);
    expect(result.band).toBe('P5');
  });

  it('max everything -> 100 (P1)', () => {
    const result = scoreLead({
      quantity: 2000, // 25
      budgetPerGiftInr: 3000, // 20
      buyerType: 'client_vip_procurement', // 15
      customisation: 'bespoke', // 15
      locationScope: 'pan_india', // 10
      timelineDays: 3, // 10
      contactQuality: 'corporate_email', // 5
    });
    expect(result.score).toBe(100);
    expect(result.band).toBe('P1');
  });
});

describe('deriveContactQuality — raw email/phone -> scoring enum', () => {
  it.each([
    ['priya@acme.com', 'corporate_email'],
    ['meera@globex.com', 'corporate_email'],
    ['Sales@Acme.CO.IN', 'corporate_email'], // case-insensitive, non-free domain
  ] as const)('company email %s -> %s', (email, expected) => {
    expect(deriveContactQuality(email)).toBe(expected);
  });

  it.each([
    'someone@gmail.com',
    'buyer@yahoo.in',
    'me@outlook.com',
    'x@icloud.com',
  ])('free-provider email %s -> email_phone', (email) => {
    expect(deriveContactQuality(email)).toBe('email_phone');
  });

  it('phone only -> phone', () => {
    expect(deriveContactQuality(undefined, '+91 98765 43210')).toBe('phone');
  });

  it('email wins over phone (company email + phone -> corporate_email)', () => {
    expect(deriveContactQuality('priya@acme.com', '9876543210')).toBe(
      'corporate_email',
    );
  });

  it('nothing usable -> undefined (caller keeps any explicit value)', () => {
    expect(deriveContactQuality()).toBeUndefined();
    expect(deriveContactQuality('not-an-email', '123')).toBeUndefined();
  });
});
