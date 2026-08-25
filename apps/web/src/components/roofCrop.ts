/*
  Cropping the roof.

  Positions are where a panel sits on the actual roof, so the grid is mostly air — 42 panels
  across 168 cells on this array.

  Renumbering the occupied tracks 0,1,2,3… would be wrong: the gaps carry meaning, since a
  blank row is the break between two roof faces. So a run of empty tracks collapses to ONE
  narrow spacer rather than vanishing.
*/

/** A rendered track: either a line of panels, or the visible seam between two blocks. */
export interface Track {
  /** The original row/column index, or null for a collapsed gap. */
  at: number | null;
}

export interface Crop {
  rows: Track[];
  columns: Track[];
  /** Original index → track index, for placing a cell. Missing means the cell is off-map. */
  rowAt: Map<number, number>;
  columnAt: Map<number, number>;
}

/**
 * Collapse the empty runs in one axis. Leading and trailing empties are dropped outright —
 * with nothing on the far side they are margin rather than meaning.
 */
function collapse(occupied: Set<number>): { tracks: Track[]; index: Map<number, number> } {
  const used = [...occupied].sort((a, b) => a - b);
  const tracks: Track[] = [];
  const index = new Map<number, number>();
  used.forEach((value, i) => {
    // One spacer per gap, however wide the gap actually was.
    if (i > 0 && value > used[i - 1] + 1) tracks.push({ at: null });
    index.set(value, tracks.length);
    tracks.push({ at: value });
  });
  return { tracks, index };
}

/**
 * Work out which tracks to draw for a set of placed cells. Given nothing placed, returns
 * empty tracks rather than a degenerate one-cell grid.
 */
export function cropRoof(cells: Array<{ x: number; y: number }>): Crop {
  const columns = collapse(new Set(cells.map((cell) => cell.x)));
  const rows = collapse(new Set(cells.map((cell) => cell.y)));
  return {
    rows: rows.tracks,
    columns: columns.tracks,
    rowAt: rows.index,
    columnAt: columns.index,
  };
}

/**
 * The CSS grid template for one axis: a gap track is a fixed sliver, a panel track shares
 * what is left. A template rather than spacer elements, so the panels stay on one grid for
 * keyboard order.
 */
export function trackTemplate(tracks: Track[], minPx: number, gapPx: number): string {
  if (!tracks.length) return `repeat(1, minmax(${minPx}px, 1fr))`;
  return tracks
    .map((track) => (track.at === null ? `${gapPx}px` : `minmax(${minPx}px, 1fr)`))
    .join(' ');
}
