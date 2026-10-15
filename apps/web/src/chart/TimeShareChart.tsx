/**
 * 分时图 —— Canvas 2D 自绘。
 *
 * 为什么不用图表库：分时图是这个品类里**最高频、最敏感**的一张图，
 * 数据每秒都在追加，图表库的通用抽象（虚拟 DOM / SVG / 逐帧重建）反而成为负担。
 * 自绘之后每个像素都在自己手里：脏区、采样、抗锯齿、DPR 都可控。
 *
 * 这张图里刻意做了几个细节，都是"懂行情"才有的：
 *  1. 价格轴以**昨收为中轴对称**，上下等幅 —— 否则涨跌的视觉冲击不对称，会误读强弱
 *  2. 右轴显示**百分比**而不是绝对价 —— 分时图的正确读法是相对昨收的偏离
 *  3. 昨收虚线 + 均价线（黄线）—— 均价是当日多空成本，是分时图的核心参考
 *  4. x 轴固定 240 格（上午 120 + 下午 120），午休不占位，曲线从左往右生长
 */
import { useEffect, useRef, useState } from 'react';
import { fmtPct, fmtPrice, fmtTime, fmtVolume } from '@stock/market-core';
import type { Bar } from '@stock/market-core';

const TOTAL_SLOTS = 240; // 一个交易日的分钟数
const PAD_L = 6;
const PAD_R = 44;
const PAD_T = 8;
const PAD_B = 12;
const VOL_H = 46;
const GAP = 8;

const COLOR_UP = '#fa5151';
const COLOR_DOWN = '#2fbe6b';
const COLOR_FLAT = '#8a8f99';
const COLOR_GRID = '#eef0f3';
const COLOR_AXIS_TEXT = '#9aa0a6';
const COLOR_AVG = '#f0a020';

interface Layout {
  plotW: number;
  priceH: number;
  volTop: number;
}

function computeLayout(width: number, height: number): Layout {
  const plotW = Math.max(10, width - PAD_L - PAD_R);
  const priceH = Math.max(10, height - PAD_T - PAD_B - VOL_H - GAP);
  return { plotW, priceH, volTop: PAD_T + priceH + GAP };
}

function draw(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  bars: Bar[],
  prevClose: number,
  cursorX: number | null,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const { plotW, priceH, volTop } = computeLayout(width, height);

  if (bars.length === 0 || prevClose <= 0) {
    ctx.fillStyle = COLOR_AXIS_TEXT;
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待行情数据…', width / 2, height / 2);
    return;
  }

  // ---- 价格轴：以昨收为中轴，上下等幅
  let maxDev = 0;
  for (const b of bars) {
    maxDev = Math.max(maxDev, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  }
  maxDev = Math.max(maxDev, prevClose * 0.002); // 至少 ±0.2%，避免横盘时线被放大成噪声
  const hi = prevClose + maxDev;
  const lo = prevClose - maxDev;

  const xOf = (i: number) => PAD_L + (i / (TOTAL_SLOTS - 1)) * plotW;
  const yOf = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * priceH;

  // ---- 网格 + 右轴百分比
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const p of [hi, prevClose + maxDev / 2, prevClose, prevClose - maxDev / 2, lo]) {
    const y = yOf(p);
    ctx.beginPath();
    ctx.strokeStyle = p === prevClose ? '#d8dbe0' : COLOR_GRID;
    ctx.setLineDash(p === prevClose ? [3, 3] : []);
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const pct = ((p - prevClose) / prevClose) * 100;
    ctx.fillStyle = pct > 0.001 ? COLOR_UP : pct < -0.001 ? COLOR_DOWN : COLOR_AXIS_TEXT;
    ctx.fillText(`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, PAD_L + plotW + 4, y);
  }

  // ---- 竖向时间分隔（10:30 / 11:30-13:00 / 14:00）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR_AXIS_TEXT;
  const marks: Array<[number, string]> = [
    [60, '10:30'],
    [120, '11:30/13:00'],
    [180, '14:00'],
  ];
  for (const [idx, label] of marks) {
    const x = xOf(idx);
    if (x < PAD_L || x > PAD_L + plotW) continue;
    ctx.beginPath();
    ctx.strokeStyle = COLOR_GRID;
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, volTop + VOL_H);
    ctx.stroke();
    ctx.fillText(label, x, height - PAD_B);
  }

  const last = bars[bars.length - 1];
  const mainColor = last.close > prevClose ? COLOR_UP : last.close < prevClose ? COLOR_DOWN : COLOR_FLAT;

  // ---- 价格曲线 + 面积渐变
  ctx.beginPath();
  bars.forEach((b, i) => {
    const x = xOf(i);
    const y = yOf(b.close);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(xOf(bars.length - 1), PAD_T + priceH);
  ctx.lineTo(xOf(0), PAD_T + priceH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + priceH);
  grad.addColorStop(0, mainColor + '2e');
  grad.addColorStop(1, mainColor + '00');
  ctx.fillStyle = grad;
  ctx.fill();

  // ---- 均价线（累计成交额 / 累计成交量）
  let cumVol = 0;
  let cumAmt = 0;
  ctx.beginPath();
  bars.forEach((b, i) => {
    cumVol += b.volume;
    cumAmt += b.amount;
    const avg = cumVol > 0 ? cumAmt / cumVol : b.close;
    const x = xOf(i);
    const y = yOf(avg);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = COLOR_AVG;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ---- 成交量
  let maxVol = 0;
  for (const b of bars) maxVol = Math.max(maxVol, b.volume);
  maxVol = maxVol || 1;
  const barW = Math.max(1, (plotW / TOTAL_SLOTS) * 0.7);
  bars.forEach((b, i) => {
    const h = (b.volume / maxVol) * VOL_H;
    ctx.fillStyle = b.close >= b.open ? COLOR_UP : COLOR_DOWN;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(xOf(i) - barW / 2, volTop + VOL_H - h, barW, h);
    ctx.globalAlpha = 1;
  });

  // ---- 最新价标签
  const lastY = yOf(last.close);
  ctx.fillStyle = mainColor;
  ctx.beginPath();
  ctx.arc(xOf(bars.length - 1), lastY, 2.4, 0, Math.PI * 2);
  ctx.fill();

  // ---- 十字光标
  if (cursorX !== null && cursorX >= PAD_L && cursorX <= PAD_L + plotW) {
    const idx = Math.max(
      0,
      Math.min(bars.length - 1, Math.round(((cursorX - PAD_L) / plotW) * (TOTAL_SLOTS - 1))),
    );
    const b = bars[idx];
    if (b) {
      const x = xOf(idx);
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
      ctx.fillStyle = mainColor;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export interface TimeShareChartProps {
  bars: Bar[];
  prevClose: number;
  height?: number;
}

export function TimeShareChart({ bars, prevClose, height = 216 }: TimeShareChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [cursorX, setCursorX] = useState<number | null>(null);

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
    draw(canvas, width, height, bars, prevClose, cursorX);
  }, [width, height, bars, prevClose, cursorX]);

  // 光标位置对应的 bar —— 提示浮层由 React 渲染，绘制和 DOM 各司其职
  const { plotW } = computeLayout(width, height);
  let active: Bar | null = null;
  if (cursorX !== null && bars.length > 0 && cursorX >= PAD_L && cursorX <= PAD_L + plotW) {
    const idx = Math.max(
      0,
      Math.min(bars.length - 1, Math.round(((cursorX - PAD_L) / plotW) * (TOTAL_SLOTS - 1))),
    );
    active = bars[idx] ?? null;
  }

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => setCursorX(e.nativeEvent.offsetX)}
        onPointerMove={(e) => {
          if (e.pressure > 0 || e.buttons > 0 || e.pointerType === 'mouse') {
            setCursorX(e.nativeEvent.offsetX);
          }
        }}
        onPointerUp={() => setCursorX(null)}
        onPointerLeave={() => setCursorX(null)}
      />
      {active && prevClose > 0 && (
        <div className="chart-tip">
          <div>{fmtTime(active.ts, false)}</div>
          <div>
            价 {fmtPrice(active.close)} 幅 {fmtPct(active.close / prevClose - 1)}
          </div>
          <div>量 {fmtVolume(active.volume)}</div>
        </div>
      )}
    </div>
  );
}
