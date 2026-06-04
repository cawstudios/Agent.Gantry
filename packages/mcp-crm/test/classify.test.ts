import { describe, expect, it } from 'vitest';
import { classifyTranscript } from '../src/reconciler/classify.js';

const customer = (text: string) => ({ role: 'customer' as const, text });
const bot = (text: string) => ({ role: 'assistant' as const, text });

describe('classifyTranscript — durable backstop heuristic', () => {
  it('reconstructs a corporate-gifting query with occasion/quantity/budget', () => {
    const result = classifyTranscript([
      customer(
        'Hi! For Diwali we want to gift one sweet box to each of our ~300 employees. Budget about ₹1,500 per box.',
      ),
      bot('Wonderful — how many cities?'),
    ]);
    expect(result).not.toBeNull();
    expect(result!.input.intentCategory).toBe('corporate');
    expect(result!.input.occasion).toBe('Diwali');
    expect(result!.input.quantity).toBe(300);
    expect(result!.input.budgetPerGiftInr).toBe(1500);
    expect(result!.input.summaryBrief).toMatch(/Auto-recovered/i);
    expect(result!.input.triggerExcerpt).toMatch(/Diwali/);
  });

  it('classifies a small personal gift as gifting_personal', () => {
    const result = classifyTranscript([
      customer('Looking for a small gift box of kaju katli for my friend.'),
    ]);
    expect(result).not.toBeNull();
    expect(result!.input.intentCategory).toBe('gifting_personal');
  });

  it('detects a total budget when phrased as a lump sum', () => {
    const result = classifyTranscript([
      customer('We want hampers for our clients, total budget around ₹50,000.'),
    ]);
    expect(result).not.toBeNull();
    expect(result!.input.intentCategory).toBe('corporate');
    expect(result!.input.budgetTotalInr).toBe(50_000);
  });

  it('returns null when there is no commercial signal', () => {
    expect(
      classifyTranscript([customer('hi'), customer('how are you?')]),
    ).toBeNull();
  });

  it('treats an order-status question as no NEW signal (not a lost lead)', () => {
    expect(
      classifyTranscript([customer('where is my order, has it shipped?')]),
    ).toBeNull();
  });

  it('ignores slash commands and empty turns', () => {
    expect(
      classifyTranscript([customer('/new'), customer('   ')]),
    ).toBeNull();
  });

  it('is deterministic — same transcript yields the same result', () => {
    const t = [customer('Need 50 ladoo boxes for a wedding next month.')];
    expect(classifyTranscript(t)).toEqual(classifyTranscript(t));
  });

  it('picks quantity only when attached to a unit (ignores bare numbers)', () => {
    const result = classifyTranscript([
      customer('Order 200 boxes of barfi please, my pin is 400001.'),
    ]);
    expect(result).not.toBeNull();
    expect(result!.input.quantity).toBe(200); // 200 boxes, not 400001
  });
});
