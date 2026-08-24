/*
  Cropping the roof.

  Positions are where a panel sits on the actual roof, so the grid they describe is mostly
  air: this array occupies rows 0-1, 3-5, 7 and 11 across columns 0-10 and 13, which is 42
  panels drawn into 168 cells. The map rendered every one of those cells, so two thirds of
  the card was empty and the panels were squeezed small to make room for nothing.

  The naive fix — renumber the occupied rows and columns 0,1,2,3… — is wrong. The gaps carry
  meaning: row 2 is the break between two roof faces, and the column-13 pair sits off on its
  own for a reason. Closing them entirely would draw a roof that does not exist, which is the
  mistake that produced the layout complaint in the first place.

  So a run of empty tracks collapses to ONE narrow spacer instead of vanishing. The blocks
  stay separated, the separation stops costing five rows of nothing, and the panels get the
  space back.
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
 * Collapse the empty runs in one axis.
 *
 * Leading and trailing empties are dropped outright — there is nothing on the far side of
 * them to separate, so they are margin rather than meaning.
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
 * Work out which tracks to draw for a set of placed cells.
 *
 * Given nothing placed, returns empty tracks rather than a degenerate one-cell grid — the
 * caller decides what an empty roof looks like.
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
 * The CSS grid template for one axis.
 *
 * A gap track is a fixed sliver; a panel track shares what is left. Expressed as a template
 * rather than by giving spacers their own elements, so nothing is added to the DOM for a
 * seam and the panels stay on one grid for keyboard order.
 */
export function trackTemplate(tracks: Track[], minPx: number, gapPx: number): string {
  if (!tracks.length) return `repeat(1, minmax(${minPx}px, 1fr))`;
  return tracks
    .map((track) => (track.at === null ? `${gapPx}px` : `minmax(${minPx}px, 1fr)`))
    .join(' ');
}
