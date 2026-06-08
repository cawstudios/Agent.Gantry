import { describe, expect, it } from 'vitest';

import { getContinuationInputDir } from '@core/runtime/continuation-input.js';
import {
  makeThreadQueueKey,
  parseThreadQueueKey,
} from '@core/shared/thread-queue-key.js';

// Regression guard for the concurrency context-bleed bug: the continuation-input
// mailbox MUST be isolated per conversation. Before the fix it was keyed only by
// the agent folder (+ a null threadId for DMs), so every concurrent customer of
// one agent shared a single `…/<agent>/input/` directory and their follow-up
// messages bled into each other's running sessions.
describe('getContinuationInputDir — per-conversation isolation', () => {
  it('gives two DM conversations on the SAME agent different input dirs', () => {
    const a = getContinuationInputDir(
      'boondi_support',
      'wa:919624194499',
      null,
    );
    const b = getContinuationInputDir(
      'boondi_support',
      'wa:919900020006',
      null,
    );
    expect(a).not.toBe(b); // the core fix: customers must not share a mailbox
    expect(a).toContain('conv-'); // namespaced per conversation
    expect(a).toContain(encodeURIComponent('wa:919624194499'));
  });

  it('is stable for the same conversation', () => {
    const a = getContinuationInputDir('boondi_support', 'wa:111', null);
    const b = getContinuationInputDir('boondi_support', 'wa:111', null);
    expect(a).toBe(b);
  });

  it('write side (from queueJid) and read side (chatJid) resolve to the SAME dir', () => {
    // group-queue derives chatJid via parseThreadQueueKey(queueJid); agent-spawn
    // uses input.chatJid. Both must land on one directory or follow-ups are lost.
    const chatJid = 'wa:919624194499';
    const queueJid = makeThreadQueueKey(chatJid, null); // == chatJid for DMs
    const readDir = getContinuationInputDir('boondi_support', chatJid, null);
    const writeDir = getContinuationInputDir(
      'boondi_support',
      parseThreadQueueKey(queueJid).chatJid,
      null,
    );
    expect(writeDir).toBe(readDir);
  });

  it('keeps threads within a conversation isolated under that conversation', () => {
    const base = getContinuationInputDir('boondi_support', 'wa:111', null);
    const threaded = getContinuationInputDir(
      'boondi_support',
      'wa:111',
      'topicA',
    );
    expect(threaded).not.toBe(base);
    expect(threaded).toContain('conv-');
  });
});
