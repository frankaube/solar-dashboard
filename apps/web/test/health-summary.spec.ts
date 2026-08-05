import { describe, expect, it } from 'vitest';
import { issueHeading, mergeIssues, pollFreshness, verdict } from '../src/pages/healthSummary';
import type { Alert, Census } from '../src/api';

/*
  The Health page's job is to be glanced at. It used to run to about seven hundred words
  across three systems that each explained themselves in full, and answered "is anything
  wrong?" nowhere — you had to read it to find out. These are the functions that answer it.
*/

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 1,
  type: 'inverter_offline',
  severity: 'serious',
  subjectKey: 'inverter:ABC:1',
  message: 'An inverter is offline',
  openedAt: '2026-08-04T10:00:00Z',
  closedAt: null,
  ackedAt: null,
  ...over,
});

const census = (findings: Census['findings']): Census => ({
  claims: [],
  findings,
  believedRatedKw: 23,
  believedFrom: 'you',
});

describe('mergeIssues', () => {
  it('puts alerts and census findings in one list, worst first', () => {
    /*
      The split was an implementation detail leaking into the interface. Nobody looking at
      this page cares which subsystem noticed a problem; they care how bad it is.
    */
    const issues = mergeIssues(
      [alert({ id: 1, severity: 'warning', message: 'A warning' })],
      census([
        { id: 'c1', severity: 'serious', headline: 'A serious finding', detail: 'why' },
        { id: 'c2', severity: 'info', headline: 'A note', detail: 'why' },
      ]),
    );
    expect(issues.map((i) => i.title)).toEqual(['A serious finding', 'A warning', 'A note']);
  });

  it('drops a census finding the alert engine already raised', () => {
    /*
      The census publishes its findings as alert candidates too, so a size mismatch arrives
      twice. Listed both ways the page reports four problems where there are three — and the
      duplicate is not obvious on screen, because the two systems word it differently.
    */
    const issues = mergeIssues(
      [alert({ message: '23 kW needs 46 panels; your gateway has 42' })],
      census([
        {
          id: 'size',
          severity: 'serious',
          headline: '23 kW needs 46 panels; your gateway has 42',
          detail: 'long explanation',
        },
      ]),
    );
    expect(issues).toHaveLength(1);
    // The alert survives rather than the finding: it is the one you can acknowledge.
    expect(issues[0].alertId).toBe(1);
  });

  it('keeps acknowledged alerts, sorted below the live ones', () => {
    /*
      Acknowledging says "I have seen this", not "this is fixed". A page that hid them would
      report all clear over a dead inverter somebody nodded at last Tuesday.
    */
    const issues = mergeIssues(
      [
        alert({ id: 1, severity: 'serious', message: 'Acked serious', ackedAt: '2026-08-04T11:00:00Z' }),
        alert({ id: 2, severity: 'info', message: 'Live note' }),
      ],
      null,
    );
    expect(issues.map((i) => i.title)).toEqual(['Live note', 'Acked serious']);
  });

  it('offers to locate only what names hardware', () => {
    const issues = mergeIssues(
      [
        alert({ id: 1, subjectKey: 'panel:ABC:2', message: 'a panel' }),
        alert({ id: 2, subjectKey: 'utility-usage', message: 'a utility thing' }),
      ],
      null,
    );
    expect(issues.find((i) => i.title === 'a panel')?.locatable).toBe(true);
    // Offering "show on roof" for this leads somewhere with nothing to show.
    expect(issues.find((i) => i.title === 'a utility thing')?.locatable).toBe(false);
  });

  it('copes with no census at all', () => {
    expect(mergeIssues([], null)).toEqual([]);
  });
});

describe('verdict', () => {
  it('says all clear when there is nothing', () => {
    const result = verdict([]);
    expect(result.rank).toBe('ok');
    expect(result.headline).toBe('All clear');
  });

  it('ranks by the worst thing, not by how many', () => {
    // One dead inverter matters more than five notes about panel counts; an average
    // would bury it.
    const issues = mergeIssues(
      [alert({ id: 1, severity: 'serious', message: 'dead inverter' })],
      census(
        Array.from({ length: 5 }, (_, i) => ({
          id: `n${i}`,
          severity: 'info' as const,
          headline: `note ${i}`,
          detail: 'x',
        })),
      ),
    );
    expect(verdict(issues).rank).toBe('serious');
    expect(verdict(issues).detail).toContain('1 serious problem');
  });

  it('does not go amber over informational notes', () => {
    /*
      A page that turns amber for "worth checking your contract" is a page whose amber
      means nothing by the second week.
    */
    const issues = mergeIssues(
      [],
      census([{ id: 'n', severity: 'info', headline: 'worth settling', detail: 'x' }]),
    );
    const result = verdict(issues);
    expect(result.rank).toBe('info');
    expect(result.headline).toBe('All clear');
    expect(result.detail).toContain('1 note');
  });

  it('counts acknowledged issues apart from live ones', () => {
    const issues = mergeIssues(
      [
        alert({ id: 1, severity: 'serious', message: 'live' }),
        alert({ id: 2, severity: 'serious', message: 'seen', ackedAt: '2026-08-04T11:00:00Z' }),
      ],
      null,
    );
    const result = verdict(issues);
    expect(result.detail).toContain('1 serious problem');
    expect(result.detail).toContain('1 acknowledged');
  });

  it('pluralises without embarrassing itself', () => {
    const one = verdict(mergeIssues([alert({ severity: 'warning' })], null));
    expect(one.detail).toContain('1 warning');
    expect(one.detail).not.toContain('1 warnings');
    const two = verdict(
      mergeIssues([alert({ id: 1, severity: 'warning' }), alert({ id: 2, severity: 'warning' })], null),
    );
    expect(two.detail).toContain('2 warnings');
  });
});

describe('pollFreshness', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');

  it('is fresh within a few poll intervals', () => {
    expect(pollFreshness('2026-08-04T11:56:00Z', now).stale).toBe(false);
  });

  it('goes stale after three missed polls', () => {
    /*
      The one failure a health page must never have: "all clear" computed from readings
      that stopped arriving three hours ago. That is not health, it is the last health it
      saw, and the two look identical until somebody checks a timestamp nobody reads.
    */
    expect(pollFreshness('2026-08-04T11:40:00Z', now).stale).toBe(true);
    expect(pollFreshness('2026-08-04T11:40:00Z', now).text).toBe('20 min ago');
  });

  it('treats never having heard anything as stale', () => {
    expect(pollFreshness(null, now).stale).toBe(true);
  });

  it('says hours once minutes stop being useful', () => {
    expect(pollFreshness('2026-08-04T09:00:00Z', now).text).toBe('3 h ago');
  });
});

describe('issueHeading', () => {
  it('counts what is outstanding, not how many rows are drawn', () => {
    /*
      "7 to look at" over a list where three are already triaged asks for work that is done
      — which is how a page teaches somebody to stop reading its headings.
    */
    const issues = mergeIssues(
      [
        alert({ id: 1, severity: 'warning', message: 'live one' }),
        alert({ id: 2, severity: 'serious', message: 'seen', ackedAt: '2026-08-04T11:00:00Z' }),
      ],
      null,
    );
    expect(issueHeading(issues)).toBe('1 to look at · 1 acknowledged');
  });

  it('does not ask for a look when everything has had one', () => {
    const issues = mergeIssues(
      [alert({ id: 1, ackedAt: '2026-08-04T11:00:00Z' })],
      null,
    );
    expect(issueHeading(issues)).toBe('1 acknowledged');
  });

  it('stays quiet about acknowledgements when there are none', () => {
    expect(issueHeading(mergeIssues([alert()], null))).toBe('1 to look at');
  });
});
