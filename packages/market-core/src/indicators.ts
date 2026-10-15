/**
 * 技术指标计算。
 *
 * 这是"金融数据"这条 JD 的落点之一：行情产品里的指标不是渲染问题，是**数值问题**。
 * 三个必须守住的规矩：
 *  1. 预热期返回 NaN，不要用 0 或首值糊弄 —— 前端要据此不画前 N 个点；
 *  2. 纯函数 + 数组入参，便于流式复用（新增一根 bar 不需要全量重算）；
 *  3. MACD/KDJ 这类递推指标必须指定初值策略，否则两端算出来不一样。
 */

/** 简单移动平均 */
export function ma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均：以前 period 个值的 SMA 作为种子（业界通行做法） */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface MacdResult {
  dif: number[];
  dea: number[];
  macd: number[];
}

/** MACD(12, 26, 9) */
export function macd(values: number[], fast = 12, slow = 26, signal = 9): MacdResult {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const dif = values.map((_, i) =>
    Number.isFinite(ef[i]) && Number.isFinite(es[i]) ? ef[i] - es[i] : NaN,
  );
  const firstValid = dif.findIndex((v) => Number.isFinite(v));
  const dea = new Array<number>(values.length).fill(NaN);
  if (firstValid >= 0) {
    const compact = dif.slice(firstValid);
    const deaCompact = ema(compact, signal);
    for (let i = 0; i < deaCompact.length; i++) dea[firstValid + i] = deaCompact[i];
  }
  const hist = values.map((_, i) =>
    Number.isFinite(dif[i]) && Number.isFinite(dea[i]) ? 2 * (dif[i] - dea[i]) : NaN,
  );
  return { dif, dea, macd: hist };
}

export interface KdjResult {
  k: number[];
  d: number[];
  j: number[];
}

/** KDJ(9, 3, 3) —— RSV 的递推平滑系数固定为 1/3 */
export function kdj(
  high: number[],
  low: number[],
  close: number[],
  period = 9,
): KdjResult {
  const n = close.length;
  const k = new Array<number>(n).fill(NaN);
  const d = new Array<number>(n).fill(NaN);
  const j = new Array<number>(n).fill(NaN);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let m = i - period + 1; m <= i; m++) {
      if (high[m] > hh) hh = high[m];
      if (low[m] < ll) ll = low[m];
    }
    const rsv = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    prevK = (2 * prevK + rsv) / 3;
    prevD = (2 * prevD + prevK) / 3;
    k[i] = prevK;
    d[i] = prevD;
    j[i] = 3 * prevK - 2 * prevD;
  }
  return { k, d, j };
}

export interface BollResult {
  mid: number[];
  upper: number[];
  lower: number[];
}

/** 布林带(20, 2)，用总体标准差（除以 n，与国内行情软件一致） */
export function boll(values: number[], period = 20, mult = 2): BollResult {
  const mid = ma(values, period);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i];
    let acc = 0;
    for (let x = i - period + 1; x <= i; x++) acc += (values[x] - m) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}
