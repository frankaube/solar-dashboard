import { describe, expect, it } from 'vitest';
import { coalesceNotifications } from '../src/alerts/alert-policy';

const offline = (serial: string) => ({
  type: 'inverter_offline',
  severity: 'serious' as const,
  subjectKey: `inverter_offline|${serial}`,
  message: `Inverter ${serial} is offline`,
});

/**
 * The reported problem: every inverter dropping at once produced one text per
 * inverter. Twelve messages in a minute, all saying the same thing.
 */
describe('coalesceNotifications', () => {
  it('folds a whole fleet into a single notification', () => {
    const groups = coalesceNotifications(
      ['4A2F', '4A30', '4A31', '4A32', '4A33', '4A34'].map(offline),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(6);
    expect(groups[0].message).toContain('6 inverters offline');
  });

  it('names the first few and counts the rest, instead of listing twelve serials', () => {
    const groups = coalesceNotifications(
      ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map(offline),
    );
    expect(groups[0].message).toContain('A1, A2, A3, A4 and 3 more');
  });

  it('leaves a single alert exactly as it was written', () => {
    // "1 inverter offline: 4A2F" would be a worse sentence than the original.
    const groups = coalesceNotifications([offline('4A2F')]);
    expect(groups[0].message).toBe('Inverter 4A2F is offline');
    expect(groups[0].count).toBe(1);
  });

  it('keeps different conditions in different notifications', () => {
    const groups = coalesceNotifications([
      offline('A1'),
      offline('A2'),
      {
        type: 'snow_cover',
        severity: 'warning',
        subjectKey: 'snow_cover|system',
        message: 'Bright sky but almost no production — panels likely snow-covered',
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.count === 2)?.message).toContain('2 inverters offline');
    expect(groups.find((g) => g.count === 1)?.message).toContain('snow-covered');
  });

  it('reports every key it stands for, so the cooldown covers all of them', () => {
    const groups = coalesceNotifications(['A1', 'A2', 'A3'].map(offline));
    expect(groups[0].keys).toEqual([
      'inverter_offline|A1',
      'inverter_offline|A2',
      'inverter_offline|A3',
    ]);
  });

  it('takes the worst severity in the group', () => {
    const groups = coalesceNotifications([
      { ...offline('A1'), severity: 'warning' as const },
      { ...offline('A2'), severity: 'serious' as const },
    ]);
    expect(groups[0].severity).toBe('serious');
  });

  it('falls back to the whole message when there is no recognisable subject', () => {
    const odd = {
      type: 'inverter_offline',
      severity: 'serious' as const,
      subjectKey: 'x',
      message: 'something unusual happened',
    };
    const groups = coalesceNotifications([odd, offline('A1')]);
    expect(groups[0].message).toContain('something unusual happened');
  });

  it('returns nothing for nothing', () => {
    expect(coalesceNotifications([])).toEqual([]);
  });
});
