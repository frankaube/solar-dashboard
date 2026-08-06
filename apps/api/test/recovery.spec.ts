import { describe, expect, it } from 'vitest';
import { parseRecoveryLog, summariseRecovery } from '../src/system/recovery';

/*
  Making self-healing visible.

  The watchdog that prompted this can bounce a link, reload a driver and reboot the machine,
  and every one of those counts as a success. A Pi doing any of them nightly looks, from the
  dashboard, exactly like a Pi that has never needed to — which turns a visible outage into
  an invisible decline that surfaces only when the repair finally stops working.

  So the tests that matter here are not about parsing. They are about a count becoming a
  sentence that tells somebody whether to go and look at the hardware.
*/

const at = (hoursAgo: number, now = Date.now()): string =>
  new Date(now - hoursAgo * 3_600_000).toISOString();

describe('parseRecoveryLog', () => {
  it('reads what the shell script writes', () => {
    const log = [
      '{"at":"2026-08-06T04:26:00-03:00","action":"link-bounce","detail":"unreachable for 3 checks; bouncing wlan0"}',
      '{"at":"2026-08-06T04:29:00-03:00","action":"driver-reload","detail":"reloading brcmfmac"}',
    ].join('\n');
    const events = parseRecoveryLog(log);
    expect(events).toHaveLength(2);
    expect(events[0].action).toBe('link-bounce');
    expect(events[1].detail).toContain('brcmfmac');
  });

  it('survives the torn last line a power cut leaves behind', () => {
    /*
      Not a hypothetical: this file is appended to by a script whose next act may be
      `systemctl reboot`, and the machine it runs on is the one that lost power. One
      half-written line must not cost the history that explains why.
    */
    const log = [
      '{"at":"2026-08-06T04:26:00Z","action":"link-bounce","detail":"ok"}',
      '{"at":"2026-08-06T04:29:00Z","action":"reb',
    ].join('\n');
    expect(parseRecoveryLog(log)).toHaveLength(1);
  });

  it('ignores lines that parse but are not events', () => {
    const log = ['{"hello":"world"}', '{"at":"not a date","action":"reboot"}', '', '   '].join('\n');
    expect(parseRecoveryLog(log)).toEqual([]);
  });
});

describe('summariseRecovery', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');

  it('says nothing when nothing has happened', () => {
    // Silence is the correct output for a machine that has not needed repairing.
    const summary = summariseRecovery([], now);
    expect(summary.verdict).toBeNull();
    expect(summary.repairs).toBe(0);
  });

  it('counts a single repair without alarming anybody', () => {
    const summary = summariseRecovery(
      [{ at: at(20, now), action: 'link-bounce', detail: '' }],
      now,
    );
    expect(summary.repairs).toBe(1);
    expect(summary.verdict).toMatch(/once/);
    expect(summary.verdict).not.toMatch(/power supply/);
  });

  it('escalates its words when the machine keeps rebooting', () => {
    /*
      The distinction the whole feature exists for. A link bounce is a network having a bad
      evening. Two reboots in a fortnight is hardware on its way out, and the screen has to
      say so rather than reporting a tidy green tick.
    */
    const summary = summariseRecovery(
      [
        { at: at(10, now), action: 'reboot', detail: '' },
        { at: at(100, now), action: 'reboot', detail: '' },
      ],
      now,
    );
    expect(summary.reboots).toBe(2);
    expect(summary.verdict).toMatch(/power supply/);
  });

  it('notices a network that is repaired constantly but never quite fails', () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      at: at(i * 20 + 1, now),
      action: 'link-bounce',
      detail: '',
    }));
    const summary = summariseRecovery(events, now);
    expect(summary.verdict).toMatch(/something upstream is unhappy/);
  });

  it('does not count a recovery as a repair', () => {
    // "recovered" is the outcome — the network came back on its own. Counting it would
    // double every incident and make a healthy machine look busy.
    const summary = summariseRecovery(
      [
        { at: at(2, now), action: 'recovered', detail: 'network returned' },
        { at: at(3, now), action: 'link-bounce', detail: '' },
      ],
      now,
    );
    expect(summary.repairs).toBe(1);
    expect(summary.events).toHaveLength(2);
  });

  it('forgets what is older than the window', () => {
    const summary = summariseRecovery(
      [{ at: at(24 * 30, now), action: 'reboot', detail: '' }],
      now,
    );
    expect(summary.events).toEqual([]);
    expect(summary.verdict).toBeNull();
  });

  it('returns newest first, because that is the one being asked about', () => {
    const summary = summariseRecovery(
      [
        { at: at(50, now), action: 'link-bounce', detail: 'older' },
        { at: at(2, now), action: 'link-bounce', detail: 'newer' },
      ],
      now,
    );
    expect(summary.events[0].detail).toBe('newer');
  });
});
