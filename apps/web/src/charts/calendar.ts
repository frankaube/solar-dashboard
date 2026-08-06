import type { EChartsOption } from 'echarts';
import { DailyEnergy } from '../api';
import { rampColor, solar } from '../theme';

/**
 * A year of production, one cell per day.
 *
 * The line charts answer "how much yesterday" well and "what does a year look like" badly:
 * 365 points on a 600px axis is four pixels a day, and the shape that actually matters —
 * the seasonal arc, the week the snow sat on the panels, the fortnight the inverter was
 * down — is the one that gets averaged into a smooth curve. A grid gives every day its own
 * mark and lets the eye find the anomaly without knowing to look for it.
 *
 * Sequential encoding, one hue, monotonic in lightness. `ramp.energy` anchors to its own
 * surface in each mode — light→dark on paper, dark→light on a dark card — because a ramp
 * flipped automatically puts its lightest step against the lightest background and the low
 * end of the scale becomes invisible rather than pale.
 */

/** Cell edge in px. Big enough that a day is a hit target, not a pinpoint. */
const CELL = 14;

export interface CalendarSummary {
  /** Days with any production at all — the denominator for anything averaged. */
  producingDays: number;
  bestDate: string | null;
  bestKwh: number;
  medianKwh: number;
  totalKwh: number;
}

/**
 * The figures the colour scale cannot state.
 *
 * A continuous ramp says "this cell is darker than that one" and nothing else — you cannot
 * read a value off it, and a reader who cannot separate the hues reads nothing at all. So
 * the same facts are also available as text beneath the grid: the best day by name, the
 * middle of the distribution, the count. Median rather than mean because a fortnight of
 * outage drags a mean down and leaves it describing no actual day.
 */
export function summarise(days: DailyEnergy[]): CalendarSummary {
  const producing = days.filter((day) => day.energyWh > 0);
  const kwh = producing.map((day) => day.energyWh / 1000).sort((a, b) => a - b);
  const best = producing.reduce<DailyEnergy | null>(
    (top, day) => (top === null || day.energyWh > top.energyWh ? day : top),
    null,
  );
  const mid = kwh.length
    ? kwh.length % 2
      ? kwh[(kwh.length - 1) / 2]
      : (kwh[kwh.length / 2 - 1] + kwh[kwh.length / 2]) / 2
    : 0;
  return {
    producingDays: producing.length,
    bestDate: best?.date ?? null,
    bestKwh: best ? best.energyWh / 1000 : 0,
    medianKwh: mid,
    totalKwh: producing.reduce((sum, day) => sum + day.energyWh, 0) / 1000,
  };
}

/**
 * The calendar's range, as ECharts wants it.
 *
 * Derived from the data rather than from today. An install three weeks old would otherwise
 * render eleven months of empty cells and read as an array that produced nothing all year,
 * which is the opposite of what a new owner should see on their first look at this page.
 */
export function calendarRange(days: DailyEnergy[]): [string, string] | null {
  if (days.length === 0) return null;
  const dates = days.map((day) => day.date).sort();
  return [dates[0], dates[dates.length - 1]];
}

export function calendarOption(days: DailyEnergy[]): EChartsOption | null {
  const range = calendarRange(days);
  if (!range) return null;

  const stops = solar.ramp.energy;
  /*
    Scaled to the best day rather than to a fixed ceiling: array sizes differ by an order
    of magnitude between installs, and a hardcoded maximum would render a 3 kW system as
    uniformly black. Guarded above zero so a day of nothing cannot divide by it.
  */
  const peak = Math.max(...days.map((day) => day.energyWh), 1) / 1000;

  return {
    animationDuration: 0,
    animationDurationUpdate: 400,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: solar.font.mono, fontSize: 11, color: solar.ink.dim },
    tooltip: {
      // Per-cell, not axis: there is no axis here, and every cell is its own fact.
      trigger: 'item',
      backgroundColor: solar.surface.raised,
      borderColor: solar.surface.borderStrong,
      borderWidth: 1,
      padding: [10, 12],
      extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45)',
      textStyle: { color: solar.ink.pri, fontSize: 12, fontFamily: solar.font.mono },
      formatter: (params: unknown) => {
        const { value } = params as { value: [string, number] };
        const [date, kwh] = value;
        const when = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
        return kwh > 0 ? `${when}<br/>${kwh.toFixed(1)} kWh` : `${when}<br/>nothing recorded`;
      },
    },
    /*
      The scale legend. A continuous ramp with no key is a picture of a year rather than a
      reading of one — the reader can see that August is darker than December and cannot
      say by how much.
    */
    visualMap: {
      type: 'continuous',
      min: 0,
      max: Math.ceil(peak),
      calculable: false,
      orient: 'horizontal',
      right: 0,
      top: 0,
      itemWidth: 10,
      itemHeight: 90,
      text: [`${Math.ceil(peak)} kWh`, '0'],
      textStyle: { color: solar.ink.dim, fontFamily: solar.font.mono, fontSize: 10 },
      inRange: { color: stops },
    },
    calendar: {
      top: 34,
      left: 34,
      right: 16,
      cellSize: [CELL, CELL],
      range,
      /*
        The 2px gap is the surface showing through between cells, not a border drawn on
        them. Drawn as a border it sits inside the cell and the mark shrinks; as a gap the
        marks stay full size and stop bleeding into one another.
      */
      splitLine: { show: false },
      itemStyle: {
        color: 'transparent',
        borderWidth: 2,
        borderColor: solar.surface.card,
      },
      yearLabel: { show: false },
      monthLabel: {
        color: solar.ink.dim,
        fontFamily: solar.font.sans,
        fontSize: 10,
      },
      dayLabel: {
        color: solar.ink.dim,
        fontFamily: solar.font.sans,
        fontSize: 9,
        /*
          Mon/Wed/Fri only. Seven labels at 9px against 14px rows do not fit — they
          collide into a smear — and the blank rows are unambiguous once their neighbours
          are named. ECharts has no interval option here, so the gaps are blank entries;
          the array starts at Sunday whatever `firstDay` is.
        */
        nameMap: ['', 'Mon', '', 'Wed', '', 'Fri', ''],
        firstDay: 1,
      },
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: days.map((day) => [day.date, Math.round((day.energyWh / 1000) * 10) / 10]),
        itemStyle: { borderRadius: 2 },
        emphasis: {
          itemStyle: {
            // A ring in the surface colour, so the hovered day separates from its
            // neighbours without changing the value its colour is reporting.
            borderColor: solar.ink.pri,
            borderWidth: 2,
          },
        },
      },
    ],
  };
}

/** The colour a given day would be drawn in — for the table twin, so both agree. */
export function cellColor(kwh: number, peakKwh: number): string {
  return rampColor(solar.ramp.energy, peakKwh > 0 ? kwh / peakKwh : 0);
}
