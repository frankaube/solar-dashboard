import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ImportSummary } from '../src/api';

/*
  The card that writes into the measurement history.

  Everything asserted here is a refusal or a disclosure. This takes a file somebody pasted
  and puts rows into the only copy of what this system has ever measured, and the failure to
  guard against is not a crash — it is an import that silently overwrites a real reading or
  inflates a day, both of which look exactly like data afterwards.
*/

const previewCloudImport = vi.fn();
const applyCloudImport = vi.fn();
const fetchCloudImports = vi.fn();
const undoCloudImport = vi.fn();

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    previewCloudImport: (...a: unknown[]) => previewCloudImport(...a),
    applyCloudImport: (...a: unknown[]) => applyCloudImport(...a),
    fetchCloudImports: (...a: unknown[]) => fetchCloudImports(...a),
    undoCloudImport: (...a: unknown[]) => undoCloudImport(...a),
  };
});

const { GapFillCard } = await import('../src/components/GapFillCard');

const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
  dates: ['2026-08-06'],
  inserted: 29,
  covered: 3,
  rejected: 0,
  perDay: [{ date: '2026-08-06', rows: 29, importedPeakWh: 3381, recordedPeakWh: 6478 }],
  from: '2026-08-06T08:35:00.000Z',
  to: '2026-08-06T10:55:00.000Z',
  applied: false,
  ...over,
});

const EXPORT = '2026-08-06 05:35\t0\n2026-08-06 05:40\t142';

beforeEach(() => {
  vi.clearAllMocks();
  fetchCloudImports.mockResolvedValue([]);
  previewCloudImport.mockResolvedValue(summary());
  applyCloudImport.mockResolvedValue(summary({ applied: true }));
  undoCloudImport.mockResolvedValue({ removed: 29 });
});

const paste = (text: string): void => {
  fireEvent.change(screen.getByLabelText(/export rows/i), { target: { value: text } });
};

describe('GapFillCard', () => {
  it('cannot write before it has previewed', async () => {
    /*
      The rule the whole card is built around. An import that parses and saves in one motion
      gives nobody the moment they need to notice the file covers the wrong day, and this
      table cannot be repaired by hand afterwards.
    */
    render(<GapFillCard />);
    paste(EXPORT);
    expect(screen.getByRole('button', { name: /fill the gap/i }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /fill the gap/i }).hasAttribute('disabled')).toBe(false),
    );
    expect(applyCloudImport).not.toHaveBeenCalled();
  });

  it('says how many rows it refused, and why', async () => {
    // "3 refused" is the visible proof that polled readings win. Without it, an import that
    // silently skipped half the file looks the same as one that took all of it.
    render(<GapFillCard />);
    paste(EXPORT);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    const notice = await screen.findByText(/29 readings to add/i);
    expect(notice.textContent).toMatch(/3 refused/);
    expect(notice.textContent).toMatch(/already recorded/i);
  });

  it('shows imported energy against the gateway’s own, so the day total can be checked', async () => {
    /*
      Not asserted, shown. Energy is rebuilt from the power curve so it always lands under
      the gateway's counter — and printing both numbers is what lets somebody verify that
      rather than take it on trust.
    */
    render(<GapFillCard />);
    paste(EXPORT);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    const line = await screen.findByText(/3381 Wh, against 6478 Wh/);
    expect(line.textContent).toMatch(/day total is unaffected/);
  });

  it('applies only what was previewed, and clears itself afterwards', async () => {
    render(<GapFillCard />);
    paste(EXPORT);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await screen.findByText(/29 readings to add/i);
    fireEvent.click(screen.getByRole('button', { name: /fill the gap/i }));
    await waitFor(() => expect(applyCloudImport).toHaveBeenCalledWith(EXPORT, undefined));
    expect(await screen.findByText(/filled 29 readings/i)).toBeTruthy();
  });

  it('says plainly when there is nothing to do', async () => {
    // Running it twice is a no-op by design, and the card has to say so rather than looking
    // like it failed.
    previewCloudImport.mockResolvedValue(summary({ inserted: 0, covered: 32, perDay: [] }));
    render(<GapFillCard />);
    paste(EXPORT);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/already has a reading for every row/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /fill the gap/i }).hasAttribute('disabled')).toBe(true);
  });

  it('passes the day through only when one was given', async () => {
    // Older exports carry a bare "05:35". Assuming today would file last week's export under
    // this morning — rows that look real, in the wrong place, forever.
    render(<GapFillCard />);
    paste('05:35\t0');
    fireEvent.change(screen.getByLabelText(/day \(only if/i), { target: { value: '2026-08-06' } });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await waitFor(() => expect(previewCloudImport).toHaveBeenCalledWith('05:35\t0', '2026-08-06'));
  });

  it('surfaces the server’s own refusal rather than a status code', async () => {
    previewCloudImport.mockRejectedValue(new Error('date must be YYYY-MM-DD'));
    render(<GapFillCard />);
    paste(EXPORT);
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/date must be YYYY-MM-DD/)).toBeTruthy();
  });

  it('lists what has been imported, and can take it back', async () => {
    // Imported rows are visible and reversible, or the provenance flag is just bookkeeping.
    fetchCloudImports.mockResolvedValue([{ localDate: '2026-08-06', rows: 29 }]);
    render(<GapFillCard />);
    // The parenthesised form is the per-day row; the bare one is the card's header badge,
    // and both are meant to be there.
    expect(await screen.findByText('(29 imported)')).toBeTruthy();
    expect(screen.getByText('2026-08-06', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(undoCloudImport).toHaveBeenCalledWith('2026-08-06'));
    expect(await screen.findByText(/removed 29 imported readings from 2026-08-06/i)).toBeTruthy();
  });
});
