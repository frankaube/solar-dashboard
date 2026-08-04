import { ReactElement, useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

interface ChartProps {
  option: EChartsOption;
  /** Fixed plot height. Ignored when `fill` is set. */
  height: number;
  /**
   * Grow to whatever height the card has, with `height` as the floor.
   *
   * Cards in a grid row stretch to the tallest column, so a fixed-height plot beside a
   * taller neighbour leaves the difference as dead space inside the card — 183 px of it
   * on the Overview. The ResizeObserver above already redraws on any size change, so
   * filling costs nothing.
   */
  fill?: boolean;
}

/** Thin ECharts host: resize-aware, updates merge so animationDurationUpdate applies. */
export function Chart({ option, height, fill }: ChartProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const instance = echarts.init(containerRef.current);
    chartRef.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option);
  }, [option]);

  return (
    <div
      ref={containerRef}
      style={
        fill
          ? { width: '100%', flex: '1 1 auto', minHeight: height }
          : { width: '100%', height }
      }
    />
  );
}
