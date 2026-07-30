import type { EChartsOption, SeriesOption } from 'echarts';
import { solar } from '../theme';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Every chart spreads this. One y-axis only — no `yAxis: [a, b]`, ever. */
export const basePreset = (): EChartsOption => ({
  animationDuration: 0,
  animationDurationUpdate: 400,
  animationEasingUpdate: 'linear',
  backgroundColor: 'transparent',
  textStyle: { fontFamily: MONO, fontSize: 11, color: solar.ink.dim },
  grid: { left: 46, right: 16, top: 20, bottom: 28, containLabel: false },
  xAxis: {
    type: 'time',
    axisLine: { lineStyle: { color: solar.grid.axis } },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { color: solar.ink.dim, fontFamily: MONO, fontSize: 10, hideOverlap: true },
  },
  yAxis: {
    type: 'value',
    min: 0,
    axisLine: { show: false },
    axisTick: { show: false },
    splitNumber: 4,
    splitLine: { lineStyle: { color: solar.grid.line, width: 1 } },
    axisLabel: { color: solar.ink.dim, fontFamily: MONO, fontSize: 10, margin: 10 },
  },
  tooltip: {
    trigger: 'axis',
    backgroundColor: solar.surface.raised,
    borderColor: solar.surface.borderStrong,
    borderWidth: 1,
    padding: [10, 12],
    extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45)',
    textStyle: { color: solar.ink.pri, fontSize: 12, fontFamily: MONO },
    axisPointer: { type: 'line', lineStyle: { color: 'rgba(232,236,244,.22)', width: 1 } },
  },
  legend: { show: false },
});

/** kW area: amber line + vertical fade, expected as a grey dashed line. */
export const powerSeries = (
  actual: Array<[string | number, number | null]>,
  expected: Array<[string | number, number | null]>,
): SeriesOption[] => [
  {
    name: 'Expected',
    type: 'line',
    data: expected,
    showSymbol: false,
    lineStyle: { color: solar.series.expected, width: 1.6, type: [4, 5] },
    z: 1,
  },
  {
    name: 'Actual',
    type: 'line',
    data: actual,
    smooth: 0.18,
    showSymbol: false,
    lineStyle: { color: solar.series.production, width: 2 },
    z: 2,
    areaStyle: {
      color: {
        type: 'linear',
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(229,165,47,.24)' },
          { offset: 1, color: 'rgba(229,165,47,0)' },
        ],
      },
    },
  },
];
