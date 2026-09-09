import { describe, expect, it } from 'vitest';
import { tabTitle } from '../src/shell/tabTitle';

// The tab label: for a dashboard left in a background tab it is most of the interface.

describe('tabTitle', () => {
  it('leads with the money and follows with the output', () => {
    expect(tabTitle(5_600, 1.82)).toBe('$1.82 · 5.6 kW · Solar');
  });

  it('keeps the money after dark, when there is no output to report', () => {
    expect(tabTitle(0, 16.94)).toBe('$16.94 · Solar');
  });

  it('says nothing about money on a day that has only just started', () => {
    // Just past midnight. "$0.00" all night is a worse label than the app's own name.
    expect(tabTitle(0, 0)).toBe('Solar Dashboard');
  });

  it('reports first light before there is a cent to show for it', () => {
    expect(tabTitle(900, 0.001)).toBe('0.9 kW · Solar');
  });

  it('treats a trickle as idle rather than as production', () => {
    // Below 50 W the array is waking or settling.
    expect(tabTitle(40, 2.5)).toBe('$2.50 · Solar');
  });

  it('keeps cents past ten dollars, so the label does not change width mid-afternoon', () => {
    expect(tabTitle(9_000, 12.5)).toBe('$12.50 · 9.0 kW · Solar');
  });
});
