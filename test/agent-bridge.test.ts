import { describe, expect, it } from 'vitest';
import { initAgentBridge } from '../src/ui/agent-bridge.ts';

/**
 * The agent bridge must not be able to *invent* inventory.
 *
 * The write path was fixed earlier: a confirmed proposal whose lot is gone is
 * dropped, never synthesized. The read path still seeded `SAMPLE_LOTS`
 * whenever its cache was empty, so an agent that asked "what is available?"
 * while the catalogue was empty — or while the request failed — was handed
 * lots with prices, MOQ and ship dates that do not exist, and could then quote
 * them to a person. An empty list is the truth in that situation.
 *
 * These tests run where no server is reachable: every `fetch` throws, which is
 * the offline / failed-read case, and the cache is empty.
 */
describe('the agent bridge reports only what the server reported', () => {
  const bridge = initAgentBridge('ws-demo-a');

  it('lists nothing rather than sample lots when the catalogue cannot be read', async () => {
    const result = await bridge.tools.listSupplyLots();
    // Not `OK`: an unreachable catalogue is `UNAVAILABLE`, and the empty `lots`
    // beside it is the absence of data, not a claim that nothing is published.
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.lots).toEqual([]);
  });

  it('refuses to price a lot it has never been told about', () => {
    expect(() => bridge.tools.quoteBooking({ lotId: 'lot-w-01', quantity: 10 })).toThrow(
      /Không tìm thấy lô hoa kiểng/,
    );
  });

  it('rejects a proposal for an unknown lot with a reason, not a made-up revision', () => {
    const result = bridge.tools.proposeBooking({
      lotId: 'lot-w-01',
      quantity: 10,
      expectedRevision: 'anything',
    });
    expect(result.status).toBe('REJECTED');
    // The union is narrowed rather than cast: a staged proposal and a rejection
    // carry different fields, and reading `reason` off the wrong one was a type
    // error this gate caught.
    if (result.status !== 'REJECTED') throw new Error(`expected a rejection, got ${result.status}`);
    expect(result.currentRevision).toBe('');
    expect(result.reason).toContain('Không tìm thấy lô hoa kiểng');
  });

  it('never claims a workspace id it was not given', () => {
    // The public catalogue projection strips workspace ids on purpose; the
    // bridge used to fill the field with a placeholder that looked real.
    const source = String(bridge.tools.listSupplyLots);
    expect(source).not.toContain('ws-public-catalog');
  });
});
