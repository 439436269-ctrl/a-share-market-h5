/**
 * K 线聚合与存储。
 *
 * 展示了一条真实的数据链路：**逐笔成交 → 1 分钟 bar → 日线 bar**。
 * 三个设计要点：
 *  1. bar 是"归并"而不是"追加"：同一个交易分钟内所有 tick 都并进同一根 bar，
 *     所以 upsert 而不是 push。写错就会得到"一分钟几十根 K 线"的诡异图。
 *  2. 粒度转换（1m → 5m/15m/60m）在读的时候聚合，写的时候只存 1m。
 *     存多份会导致一致性问题，读时聚合的代价在这个量级可以忽略。
 *  3. 日线历史由确定性伪随机生成（Demo 需要立即可见的 K 线），
 *     换真实数据源时只需替换 seedDaily()，聚合逻辑完全不用动。
 */
import { PERIOD_MS, cnParts, sessionMinuteIndex } from '@stock/market-core';
import type { Bar, Instrument, Period } from '@stock/market-core';
import { INSTRUMENTS } from './instruments';

const DAY_MS = 86_400_000;
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 交易分钟序号 → 时间戳。
 *
 * 这是本项目踩过的一个真实坑：**"第几个交易分钟"和"墙上时钟分钟"是两套坐标**。
 *   09:30 → 序号 0 ；11:30 → 序号 119 ；13:00 → 序号 120（不是 240！）
 * 如果按"时间戳 = 09:30 + 序号 × 60s"来算，序号 120 会被算成 11:30，
 * 而实时 tick 的墙上时间算出来是 13:00 —— 两套口径对不上，
 * 归并（upsert）永远命中不了同一根 bar，于是分时图会"长出一堆碎柱"。
 * 午休不占位，正是分时图 x 轴的核心约定。
 */
export function sessionSlotToEpoch(slot: number, dayMs = Date.now()): number {
  const { date } = cnParts(dayMs);
  const [y, m, d] = date.split('-').map(Number);
  const cnMidnight = Date.UTC(y, m - 1, d) - CN_OFFSET_MS;
  const seconds =
    slot < 120 ? 9 * 3600 + 30 * 60 + slot * 60 : 13 * 3600 + (slot - 120) * 60;
  return cnMidnight + seconds * 1000;
}

/** mulberry32：确定性 PRNG，保证同一标的每次启动生成的日线完全一致 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 最近 count 个交易日（跳过周末） */
function recentTradingDays(count: number, endMs = Date.now()): number[] {
  const out: number[] = [];
  let ms = endMs;
  while (out.length < count) {
    const { weekday } = cnParts(ms);
    if (weekday !== 0 && weekday !== 6) out.push(ms);
    ms -= DAY_MS;
  }
  return out.reverse();
}

export class KlineStore {
  /** 当日 1 分钟 bar（唯一写入粒度） */
  private readonly session = new Map<string, Bar[]>();
  /** 日线历史 */
  private readonly daily = new Map<string, Bar[]>();

  constructor(dailyCount = 160) {
    for (const inst of INSTRUMENTS) {
      this.session.set(inst.symbol, []);
      this.daily.set(inst.symbol, this.seedDaily(inst, dailyCount));
    }
  }

  /** 合成日线历史，最后一根 bar 的收盘价对齐到昨收，保证与实时行情衔接得上 */
  private seedDaily(inst: Instrument, count: number): Bar[] {
    const rand = mulberry32(hashSeed(inst.symbol));
    const sigma = inst.board === 'index' ? 0.009 : 0.021;
    const path: number[] = [];
    let p = inst.prevClose;
    for (let i = 0; i < count; i++) {
      // 略带趋势的随机游走，避免看起来像心电图
      const drift = (rand() - 0.48) * sigma * 0.35;
      p = Math.max(0.5, p * (1 + drift + sigma * (rand() * 2 - 1)));
      path.push(p);
    }
    // 整体缩放，让最后一根收在昨收上
    const scale = inst.prevClose / path[path.length - 1];
    for (let i = 0; i < count; i++) path[i] *= scale;

    const days = recentTradingDays(count);
    const bars: Bar[] = [];
    let prevClose = path[0];
    for (let i = 0; i < count; i++) {
      const close = round2(path[i]);
      const open = round2(prevClose * (1 + (rand() - 0.5) * 0.006));
      const high = round2(Math.max(open, close) * (1 + rand() * 0.012));
      const low = round2(Math.min(open, close) * (1 - rand() * 0.012));
      const volume = (1_000 + Math.floor(rand() * 9_000)) * 10_000;
      bars.push({
        ts: days[i],
        open,
        high,
        low,
        close,
        volume,
        amount: volume * ((open + close) / 2),
      });
      prevClose = close;
    }
    return bars;
  }

  /**
   * 播种当日分时：从 prevClose 走到当前价，生成 elapsedMinutes 根 1 分钟 bar。
   *
   * 作用是让服务**任何时刻启动都立刻有一张完整的分时图**，而不是从空图开始长。
   * prevClose 必须由调用方传入（而不是读主数据里的静态值）：
   * 虚拟翻日后昨收会变，用静态值会导致曲线基准线和涨跌幅对不上。
   */
  seedSession(
    symbol: string,
    prevClose: number,
    last: number,
    elapsedMinutes: number,
    dayMs = Date.now(),
  ): Bar[] {
    if (elapsedMinutes <= 0 || prevClose <= 0) {
      this.session.set(symbol, []);
      return [];
    }
    const rand = mulberry32(hashSeed(symbol + ':session:' + Math.floor(dayMs / DAY_MS)));
    const sigma = 0.0007;
    const n = Math.min(elapsedMinutes, 240);

    const path: number[] = [];
    let p = prevClose;
    for (let i = 0; i < n; i++) {
      p = p * (1 + sigma * (rand() * 2 - 1));
      path.push(p);
    }
    // 缩放到终点等于当前价，保证与实时行情无缝衔接
    const scale = last > 0 && path[n - 1] > 0 ? last / path[n - 1] : 1;
    for (let i = 0; i < n; i++) path[i] *= scale;

    const bars: Bar[] = [];
    let prev = prevClose;
    for (let i = 0; i < n; i++) {
      const close = round2(path[i]);
      const open = round2(prev);
      const high = round2(Math.max(open, close) * (1 + rand() * 0.0008));
      const low = round2(Math.min(open, close) * (1 - rand() * 0.0008));
      const volume = (200 + Math.floor(rand() * 3_000)) * 100;
      bars.push({
        ts: sessionSlotToEpoch(i, dayMs),
        open,
        high,
        low,
        close,
        volume,
        amount: volume * ((open + close) / 2),
      });
      prev = close;
    }
    this.session.set(symbol, bars);
    return bars;
  }

  /** 逐笔成交归并进 1 分钟 bar（按"交易分钟序号"定位，与播种口径完全一致） */
  appendTick(symbol: string, price: number, volume: number, at: number): void {
    const bars = this.session.get(symbol);
    if (!bars) return;
    const slot = sessionMinuteIndex(at);
    if (slot < 0) return; // 非交易时段不产生 bar
    const ts = sessionSlotToEpoch(slot, at);
    const last = bars[bars.length - 1];

    if (last && last.ts === ts) {
      // upsert：同一分钟内归并
      last.close = price;
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      last.volume += volume;
      last.amount += volume * price;
      return;
    }
    // 时间倒流的帧直接丢弃（乱序保护）
    if (last && ts < last.ts) return;

    bars.push({
      ts,
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
      amount: volume * price,
    });
    // 只保留当日 240 根，防止长时间运行内存无限增长
    if (bars.length > 240) bars.splice(0, bars.length - 240);
  }

  /** 收盘：把当日分时压成一根日线并归档 */
  commitDay(): void {
    for (const [symbol, bars] of this.session) {
      if (bars.length === 0) continue;
      const daily = this.daily.get(symbol);
      if (!daily) continue;
      const dayBar: Bar = {
        ts: bars[0].ts,
        open: bars[0].open,
        high: Math.max(...bars.map((b) => b.high)),
        low: Math.min(...bars.map((b) => b.low)),
        close: bars[bars.length - 1].close,
        volume: bars.reduce((s, b) => s + b.volume, 0),
        amount: bars.reduce((s, b) => s + b.amount, 0),
      };
      daily.push(dayBar);
      if (daily.length > 400) daily.splice(0, daily.length - 400);
    }
  }

  /** 新交易日：清空当日分时 */
  resetSession(): void {
    for (const key of this.session.keys()) this.session.set(key, []);
  }

  /** 读时聚合：1m → 5m/15m/30m/60m */
  private aggregate(bars: Bar[], periodMs: number): Bar[] {
    const out: Bar[] = [];
    let cur: Bar | null = null;
    for (const b of bars) {
      const bucket = Math.floor(b.ts / periodMs) * periodMs;
      if (!cur || cur.ts !== bucket) {
        if (cur) out.push(cur);
        cur = { ...b, ts: bucket };
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume;
        cur.amount += b.amount;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  get(symbol: string, period: Period, limit = 240): Bar[] {
    if (period === '1d') {
      const daily = this.daily.get(symbol) ?? [];
      return daily.slice(-limit);
    }
    const session = this.session.get(symbol) ?? [];
    const agg = period === '1m' ? session : this.aggregate(session, PERIOD_MS[period]);
    return agg.slice(-limit);
  }

  /** 当日已生成的 bar 数量（调试/统计用） */
  sessionSize(symbol: string): number {
    return this.session.get(symbol)?.length ?? 0;
  }
}
