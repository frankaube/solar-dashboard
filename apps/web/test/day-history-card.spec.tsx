import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DayHistory } from '../src/api';

/*
  One day of the roof. The tests that matter are the edges of the record and the difference
  between "nothing was recorded" and "the array made nothing" — identical flat lines on a
  chart, only one of them about the weather.
*/

const fetchDay = vi.fn();

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return { ...actual, fetchDay: (...a: unknown[]) => fetchDay(...a) };
});

/*
  ECharts draws to a canvas, which jsdom does not implement, and refuses to initialise where
  every element measures zero. Under test here is the navigation, the total and the copy.
*/
vi.mock('../src/charts/Chart', () => ({ Chart: () => null }));

const { DayHistoryCard } = await import('../src/components/DayHistoryCard');

const day = (over: Partial<DayHistory> = {}): DayHistory => ({
  date: '2026-08-06',
  points: [
    { t: '2026-08-06T13:00:00Z', powerW: 9000 },
    { t: '2026-08-06T13:05:00Z', powerW: 9500 },
  ],
  energyWh: 42_290,
  importedPoints: 0,
  previous: null,
  earliest: '2026-07-23',
  latest: '2026-08-06',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchDay.mockResolvedValue(day());
});

describe('DayHistoryCard', () => {
  it('opens on today and shows the day’s total', async () => {
    render(<DayHistoryCard today="2026-08-06" />);
    expect(await screen.findByText('42.29 kWh')).toBeTruthy();
    await waitFor(() => expect(fetchDay).toHaveBeenCalledWith('2026-08-06', false));
  });

  it('will not walk past either end of the record', async () => {
    render(<DayHistoryCard today="2026-08-06" />);
    await screen.findByText('42.29 kWh');
    expect(screen.getByLabelText('Next day').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Previous day').hasAttribute('disabled')).toBe(false);

    fetchDay.mockResolvedValue(day({ date: '2026-07-23', energyWh: 39_985 }));
    fireEvent.click(screen.getByLabelText('Previous day'));
    await waitFor(() => expect(fetchDay).toHaveBeenCalledWith('2026-08-05', false));
  });

  it('stops at the oldest day the record holds', async () => {
    fetchDay.mockResolvedValue(day({ date: '2026-07-23', earliest: '2026-07-23' }));
    render(<DayHistoryCard today="2026-07-23" />);
    await screen.findByText('42.29 kWh');
    expect(screen.getByLabelText('Previous day').hasAttribute('disabled')).toBe(true);
  });

  it('asks for the day before only when the comparison is ticked', async () => {
    render(<DayHistoryCard today="2026-08-06" />);
    await screen.findByText('42.29 kWh');
    fireEvent.click(screen.getByLabelText('Compare with the day before'));
    await waitFor(() => expect(fetchDay).toHaveBeenCalledWith('2026-08-06', true));
  });

  it('says so when the day before has nothing to compare against', async () => {
    // An install's first day, or a day the collector missed entirely.
    fetchDay.mockResolvedValue(day({ previous: null }));
    render(<DayHistoryCard today="2026-08-06" />);
    await screen.findByText('42.29 kWh');
    fireEvent.click(screen.getByLabelText('Compare with the day before'));
    expect(await screen.findByText(/nothing was recorded the day before/i)).toBeTruthy();
  });

  it('tells a day with no readings apart from a day that made nothing', async () => {
    // One is weather and one is a gap in collection: a null total, not a zero one.
    fetchDay.mockResolvedValue(day({ points: [], energyWh: null }));
    render(<DayHistoryCard today="2026-08-06" />);
    expect(await screen.findByText(/nothing was recorded on this day/i)).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('admits when part of a day was imported rather than measured', async () => {
    // Imported readings come from a vendor export backfilling a collection outage.
    fetchDay.mockResolvedValue(day({ importedPoints: 29 }));
    render(<DayHistoryCard today="2026-08-06" />);
    expect(await screen.findByText(/29 of these readings were imported/i)).toBeTruthy();
  });

  it('offers a way back to today once you have wandered', async () => {
    render(<DayHistoryCard today="2026-08-06" />);
    await screen.findByText('42.29 kWh');
    expect(screen.queryByText('back to today')).toBeNull();
    fireEvent.click(screen.getByLabelText('Previous day'));
    expect(await screen.findByText('back to today')).toBeTruthy();
  });
});
