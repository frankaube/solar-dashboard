import { describe, expect, it } from 'vitest';
import { cropRoof, trackTemplate } from '../src/components/roofCrop';

/*
  This roof describes a mostly empty grid: 42 panels across rows 0-1, 3-5, 7 and 11, columns
  0-10 and 13 — 168 cells for 42 panels.

  Gaps must not close entirely: row 2 is the break between two roof faces and the column-13
  pair sits apart, so renumbering to 0,1,2,3… would draw a roof that does not exist. A run of
  empties collapses to one spacer instead.
*/

/** The real layout: two blocks, a right-hand pair, and a lot of nothing in between. */
const ROOF = [
  ...[0, 2, 3, 4, 5, 6, 7, 8, 10].map((x) => ({ x, y: 0 })),
  ...Array.from({ length: 11 }, (_, x) => ({ x, y: 1 })),
  ...Array.from({ length: 11 }, (_, x) => ({ x, y: 3 })),
  ...[0, 2, 3, 4, 5, 6, 7].map((x) => ({ x, y: 4 })),
  ...[4, 5].map((x) => ({ x, y: 5 })),
  { x: 13, y: 7 },
  { x: 13, y: 11 },
];

describe('cropRoof', () => {
  it('collapses a run of empty rows to a single seam', () => {
    // Rows 8, 9 and 10 are empty between the two lone panels — that is one seam, not three.
    const { rows } = cropRoof(ROOF);
    expect(rows.map((r) => r.at)).toEqual([0, 1, null, 3, 4, 5, null, 7, null, 11]);
  });

  it('collapses the empty columns the same way', () => {
    // Columns 11 and 12 have nothing in them; 13 does.
    const { columns } = cropRoof(ROOF);
    expect(columns.map((c) => c.at)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null, 13]);
  });

  it('keeps the blocks apart rather than renumbering them together', () => {
    // Rows 1 and 3 are different roof faces; renumbered to 0,1,2,3 they would draw touching.
    const { rowAt } = cropRoof(ROOF);
    expect(rowAt.get(3)! - rowAt.get(1)!).toBe(2); // one seam between them
  });

  it('drops leading and trailing emptiness outright', () => {
    // Nothing on the far side to separate, so it is margin rather than meaning.
    const { rows, columns } = cropRoof([{ x: 5, y: 4 }]);
    expect(rows.map((r) => r.at)).toEqual([4]);
    expect(columns.map((c) => c.at)).toEqual([5]);
  });

  it('leaves a dense block completely untouched', () => {
    const dense = Array.from({ length: 6 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3) }));
    const { rows, columns } = cropRoof(dense);
    expect(rows.map((r) => r.at)).toEqual([0, 1]);
    expect(columns.map((c) => c.at)).toEqual([0, 1, 2]);
  });

  it('survives an empty roof without inventing a cell', () => {
    const { rows, columns, rowAt } = cropRoof([]);
    expect(rows).toEqual([]);
    expect(columns).toEqual([]);
    expect(rowAt.size).toBe(0);
  });

  it('maps every placed cell to a track', () => {
    const { rowAt, columnAt } = cropRoof(ROOF);
    for (const cell of ROOF) {
      expect(rowAt.has(cell.y)).toBe(true);
      expect(columnAt.has(cell.x)).toBe(true);
    }
  });
});

describe('trackTemplate', () => {
  it('gives a seam a fixed sliver and the panels the rest', () => {
    const template = trackTemplate([{ at: 0 }, { at: null }, { at: 3 }], 44, 14);
    expect(template).toBe('minmax(44px, 1fr) 14px minmax(44px, 1fr)');
  });

  it('falls back to one column rather than emitting an empty template', () => {
    // `grid-template-columns: ` is invalid CSS and would collapse the whole card.
    expect(trackTemplate([], 44, 14)).toBe('repeat(1, minmax(44px, 1fr))');
  });
});
