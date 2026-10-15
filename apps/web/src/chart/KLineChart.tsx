/**
 * 日 K 线 —— Canvas 2D 自绘（蜡烛 + 均线 + 成交量 + 十字光标）。
 *
 * 细节取舍（都是国内行情软件的通行做法）：
 *  - **阳线空心、阴线实心**：一眼能分辨涨跌，也避免大面积红绿糊在一起
 *  - 十字光标是"读数"工具，必须同时给出 开/高/低/收 + 涨跌幅 + 成交量
 *  - 均线用固定配色（MA5 橙 / MA10 蓝 / MA20 紫），这是用户的肌肉记忆，不要创新
 *  - 成交量与价格分区绘制，共用 x 轴但各自独立缩放
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtPct, fmtPrice, fmtVolume, ma } from '@stock/market-core';
import type { Bar } from '@stock/market-core';

const PAD_L = 6;
const PAD_R = 46;
const PAD_T = 10;
const PAD_B = 14;
const VOL_H = 42;
const GAP = 8;

const COLOR_UP = '#fa5151';
const COLOR_DOWN = '#2fbe6b';
const COLOR_GRID = '#eef0f3';
const COLOR_AXIS_TEXT = '#9aa0a6';
const MA_COLORS = ['#f0a020', '#3d7bfa', '#a855f7'];

interface Layout {
  plotW: number;
  slotW: number;
  priceH: number;
  volTop: number;
}

function computeLayout(width: number, height: number, n: number): Layout {
  const plotW = Math.max(10, width - PAD_L - PAD_R);
  const priceH = Math.max(10, height - PAD_T - PAD_B - VOL_H - GAP);
  return {
    plotW,
    slotW: plotW / Math.max(1, n),
    priceH,
    volTop: PAD_T + priceH + GAP,
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function draw(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  bars: Bar[],
  mas: number[][],
  cursorIdx: number | null,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (bars.length === 0) {
    ctx.fillStyle = COLOR_AXIS_TEXT;
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无 K 线数据', width / 2, height / 2);
    return;
  }

  const n = bars.length;
  const { plotW, slotW, priceH, volTop } = computeLayout(width, height, n);

  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
  }
  for (const series of mas) {
    for (const v of series) {
      if (Number.isFinite(v)) {
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
    }
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) {
    hi = (hi || 1) * 1.02;
    lo = (lo || 0) * 0.98;
  }
  const pad = (hi - lo) * 0.05;
  hi += pad;
  lo -= pad;

  const xOf = (i: number) => PAD_L + (i + 0.5) * slotW;
  const yOf = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * priceH;

  // ---- 网格 + 右轴价格
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const p = lo + ((hi - lo) * k) / 4;
    const y = yOf(p);
    ctx.beginPath();
    ctx.strokeStyle = COLOR_GRID;
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + plotW, y);
    ctx.stroke();
    ctx.fillStyle = COLOR_AXIS_TEXT;
    ctx.fillText(p.toFixed(2), PAD_L + plotW + 4, y);
  }

  // ---- 蜡烛
  const bodyW = Math.max(1, slotW * 0.62);
  bars.forEach((b, i) => {
    const x = xOf(i);
    const up = b.close >= b.open;
    const color = up ? COLOR_UP : COLOR_DOWN;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    // 影线
    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.moveTo(x, yOf(b.high));
    ctx.lineTo(x, yOf(b.low));
    ctx.stroke();

    // 实体：阳线空心、阴线实心
    const yo = yOf(b.open);
    const yc = yOf(b.close);
    const top = Math.min(yo, yc);
    const h = Math.max(1, Math.abs(yc - yo));
    if (up) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
      ctx.strokeRect(x - bodyW / 2 + 0.5, top + 0.5, bodyW - 1, h - 1);
    } else {
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    }
  });

  // ---- 均线
  mas.forEach((series, k) => {
    ctx.beginPath();
    ctx.strokeStyle = MA_COLORS[k];
    ctx.lineWidth = 1;
    let started = false;
    series.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = xOf(i);
      const y = yOf(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  // ---- 均线图例
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let legendX = PAD_L + 2;
  ['MA5', 'MA10', 'MA20'].forEach((label, k) => {
    const lastVal = [...mas[k]].reverse().find((v) => Number.isFinite(v));
    ctx.fillStyle = MA_COLORS[k];
    const text = `${label} ${lastVal !== undefined ? lastVal.toFixed(2) : '--'}`;
    ctx.fillText(text, legendX, 1);
    legendX += ctx.measureText(text).width + 10;
  });

  // ---- 成交量
  let maxVol = 0;
  for (const b of bars) maxVol = Math.max(maxVol, b.volume);
  maxVol = maxVol || 1;
  bars.forEach((b, i) => {
    const h = (b.volume / maxVol) * VOL_H;
    ctx.fillStyle = b.close >= b.open ? COLOR_UP : COLOR_DOWN;
    ctx.globalAlpha = 0.72;
    ctx.fillRect(xOf(i) - bodyW / 2, volTop + VOL_H - h, bodyW, h);
    ctx.globalAlpha = 1;
  });

  // ---- x 轴日期（首/中/尾）
  ctx.fillStyle = COLOR_AXIS_TEXT;
  ctx.textBaseline = 'top';
  const tickIdx = [0, Math.floor(n / 2), n - 1];
  tickIdx.forEach((i, k) => {
    const x = xOf(i);
    ctx.textAlign = k === 0 ? 'left' : k === 2 ? 'right' : 'center';
    const cx = k === 0 ? Math.max(PAD_L, x - slotW) : k === 2 ? PAD_L + plotW : x;
    ctx.fillText(fmtDate(bars[i].ts), cx, volTop + VOL_H + 2);
  });

  // ---- 十字光标
  if (cursorIdx !== null && bars[cursorIdx]) {
    const b = bars[cursorIdx];
    const x = xOf(cursorIdx);
    const y = yOf(b.close);
    ctx.beginPath();
    ctx.strokeStyle = '#8a8f99';
    ctx.setLineDash([3, 3]);
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, volTop + VOL_H);
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export interface KLineChartProps {
  bars: Bar[];
  height?: number;
}

export function KLineChart({ bars, height = 250 }: KLineChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);

  const closes = useMemo(() => bars.map((b) => b.close), [bars]);
  const mas = useMemo(
    () => [ma(closes, 5), ma(closes, 10), ma(closes, 20)],
    [closes],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    draw(canvas, width, height, bars, mas, cursorIdx);
  }, [width, height, bars, mas, cursorIdx]);

  const { plotW, slotW } = computeLayout(width, height, bars.length);
  const fromX = (offsetX: number): number | null => {
    if (bars.length === 0 || offsetX < PAD_L || offsetX > PAD_L + plotW) return null;
    const idx = Math.floor((offsetX - PAD_L) / slotW);
    return Math.max(0, Math.min(bars.length - 1, idx));
  };

  const active = cursorIdx !== null ? bars[cursorIdx] : null;
  const prev = cursorIdx !== null && cursorIdx > 0 ? bars[cursorIdx - 1] : null;
  const chg = active && prev && prev.close ? active.close / prev.close - 1 : 0;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => setCursorIdx(fromX(e.nativeEvent.offsetX))}
        onPointerMove={(e) => {
          if (e.pressure > 0 || e.buttons > 0 || e.pointerType === 'mouse') {
            setCursorIdx(fromX(e.nativeEvent.offsetX));
          }
        }}
        onPointerUp={() => setCursorIdx(null)}
        onPointerLeave={() => setCursorIdx(null)}
      />
      {active && (
        <div className="chart-tip">
          <div>{fmtDate(active.ts)}</div>
          <div>
            开 {fmtPrice(active.open)} 高 {fmtPrice(active.high)}
          </div>
          <div>
            低 {fmtPrice(active.low)} 收 {fmtPrice(active.close)}
          </div>
          <div>
            幅 {fmtPct(chg)} 量 {fmtVolume(active.volume)}
          </div>
        </div>
      )}
    </div>
  );
}
