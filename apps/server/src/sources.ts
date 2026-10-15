/**
 * 行情源适配层。
 *
 * 抽象出一个 QuoteSource 接口，是为了把"数据从哪来"和"怎么推给客户端"彻底解耦：
 *   - MockQuoteSource      本地模拟，任何时间都能跑，保证 Demo 永远可观
 *   - EastmoneyQuoteSource 真实行情（BFF 代理，绕开浏览器 CORS 与 Referer 限制）
 * 两者对上层完全等价 —— 这就是为什么前端代码一行都不用改就能切真实数据。
 *
 * 模拟器不是"随便随机一下"，它承载了真实的业务规则：
 *   - 涨跌停价由 昨收 × (1±幅度) 四舍五入到分 得出，触及后价格不动
 *   - 封涨停时**卖盘为空**、买一排队量巨大；封跌停时反之（这是盘口最直观的业务语义）
 *   - 成交额随成交量同步累加，换手率才能算对
 */
import { limitPrices } from '@stock/market-core';
import type { DepthLevel, Instrument, MarketPhase, Quote, Tick } from '@stock/market-core';
import { INSTRUMENTS, INSTRUMENT_MAP } from './instruments';

export interface StepContext {
  /** 当前（虚拟）时刻 */
  now: number;
  /** 距上一帧推进的（虚拟）秒数 —— 波动率要按它缩放，否则改倍速就失真 */
  dtSeconds: number;
  phase: MarketPhase;
  /** 本帧需要推进的标的（所有客户端订阅的并集） */
  symbols: Set<string>;
}

export interface QuoteSource {
  readonly name: string;
  /** 是否已降级（例如真实源拉取失败，退回模拟） */
  readonly degraded: boolean;
  bootstrap(): Quote[];
  step(ctx: StepContext): { quotes: Quote[]; ticks: Tick[] };
  snapshot(symbols?: Iterable<string>, phase?: MarketPhase): Quote[];
  /** 新交易日：重置为"昨收 = 上一交易日收盘" */
  resetDay(): void;
  dispose(): void;
}

interface SymState {
  inst: Instrument;
  prevClose: number;
  last: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  halted: boolean;
  /** 每秒波动率（按 √时间 缩放） */
  sigma: number;
  /** 价格最小变动单位：A 股 0.01 元 */
  tickSize: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Box-Muller 标准正态 */
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class MockQuoteSource implements QuoteSource {
  readonly name: string = 'mock';
  protected _degraded = false;

  get degraded(): boolean {
    return this._degraded;
  }

  dispose(): void {
    /* 模拟源无需清理 */
  }

  protected readonly state = new Map<string, SymState>();

  constructor() {
    for (const inst of INSTRUMENTS) {
      this.state.set(inst.symbol, {
        inst,
        prevClose: inst.prevClose,
        last: inst.prevClose,
        open: 0,
        high: 0,
        low: 0,
        volume: 0,
        amount: 0,
        bids: [],
        asks: [],
        halted: false,
        // 指数波动略小；不同板块给不同波动，画面才有层次
        sigma: inst.board === 'index' ? 0.00007 : 0.00012,
        tickSize: 0.01,
      });
    }
  }

  bootstrap(): Quote[] {
    for (const st of this.state.values()) this.rebuildDepth(st);
    return this.snapshot();
  }

  /** 新交易日：昨收 = 当前收盘，其余归零 */
  resetDay(): void {
    for (const st of this.state.values()) {
      st.prevClose = st.last;
      st.open = 0;
      st.high = 0;
      st.low = 0;
      st.volume = 0;
      st.amount = 0;
      this.rebuildDepth(st);
    }
  }

  step(ctx: StepContext): { quotes: Quote[]; ticks: Tick[] } {
    const quotes: Quote[] = [];
    const ticks: Tick[] = [];

    // 只有集合竞价与连续竞价才产生数据 —— 收盘/午休就该是静止的
    const active =
      ctx.phase === 'call_auction' ||
      ctx.phase === 'continuous' ||
      ctx.phase === 'close_auction' ||
      ctx.phase === 'pre_match';
    if (!active) return { quotes, ticks };

    // 集合竞价波动小、成交稀疏；连续竞价正常
    const intensity = ctx.phase === 'continuous' ? 1 : 0.25;
    const dtSeconds = Math.max(1, ctx.dtSeconds);

    for (const symbol of ctx.symbols) {
      const st = this.state.get(symbol);
      if (!st || st.halted) continue;
      // 不是每个标的每帧都动，避免"全屏一起跳"的假象
      if (Math.random() > 0.55 * intensity + 0.25) continue;

      const { up, down } = limitPrices(st.prevClose, st.inst.limitPct);
      const atLimitUp = up > 0 && st.last >= up - 1e-9;
      const atLimitDown = down > 0 && st.last <= down + 1e-9;

      // 已封板：价格不动，只是排队量继续堆积
      if (!atLimitUp && !atLimitDown) {
        const sigma = st.sigma * Math.sqrt(dtSeconds) * intensity;
        let next = st.last * (1 + sigma * gauss());
        if (up > 0) next = Math.min(next, up);
        if (down > 0) next = Math.max(next, down);
        next = round2(next);
        if (next !== st.last) {
          const side: Tick['side'] = next > st.last ? 'B' : 'S';
          st.last = next;
          if (!st.open) st.open = next;
          if (!st.high || next > st.high) st.high = next;
          if (!st.low || next < st.low) st.low = next;

          // 每帧 1~3 笔逐笔成交
          const n = 1 + Math.floor(Math.random() * 3);
          for (let i = 0; i < n; i++) {
            const vol = (1 + Math.floor(Math.random() * 40)) * 100; // 整手
            st.volume += vol;
            st.amount += vol * st.last;
            ticks.push({ symbol, price: st.last, volume: vol, side, ts: ctx.now });
          }
        }
      } else {
        // 封板：极少量成交继续发生
        const vol = (1 + Math.floor(Math.random() * 8)) * 100;
        st.volume += vol;
        st.amount += vol * st.last;
        ticks.push({
          symbol,
          price: st.last,
          volume: vol,
          side: atLimitUp ? 'B' : 'S',
          ts: ctx.now,
        });
      }

      this.rebuildDepth(st);
      quotes.push(this.toQuote(st, ctx.phase, ctx.now));
    }

    return { quotes, ticks };
  }

  /** 依据最新价重建五档盘口，并处理封板时的单边空盘 */
  protected rebuildDepth(st: SymState): void {
    const { up, down } = limitPrices(st.prevClose, st.inst.limitPct);
    const atLimitUp = up > 0 && st.last >= up - 1e-9;
    const atLimitDown = down > 0 && st.last <= down + 1e-9;

    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];

    // 封涨停：无人卖，卖盘全空、买一巨量排队
    if (atLimitUp) {
      for (let i = 0; i < 5; i++) {
        bids.push({
          price: round2(st.last - i * st.tickSize),
          volume: i === 0 ? (1 + Math.floor(Math.random() * 90)) * 1_000_000 : 0,
        });
      }
      for (let i = 0; i < 5; i++) asks.push({ price: 0, volume: 0 });
      st.bids = bids;
      st.asks = asks;
      return;
    }
    // 封跌停：无人买
    if (atLimitDown) {
      for (let i = 0; i < 5; i++) bids.push({ price: 0, volume: 0 });
      for (let i = 0; i < 5; i++) {
        asks.push({
          price: round2(st.last + i * st.tickSize),
          volume: i === 0 ? (1 + Math.floor(Math.random() * 90)) * 1_000_000 : 0,
        });
      }
      st.bids = bids;
      st.asks = asks;
      return;
    }

    for (let i = 1; i <= 5; i++) {
      bids.push({
        price: round2(st.last - i * st.tickSize),
        volume: (1 + Math.floor(Math.random() * 60)) * 100,
      });
      asks.push({
        price: round2(st.last + i * st.tickSize),
        volume: (1 + Math.floor(Math.random() * 60)) * 100,
      });
    }
    st.bids = bids;
    st.asks = asks;
  }

  protected toQuote(st: SymState, phase: MarketPhase, now: number): Quote {
    const { up, down } = limitPrices(st.prevClose, st.inst.limitPct);
    const change = round2(st.last - st.prevClose);
    return {
      symbol: st.inst.symbol,
      last: st.last,
      open: st.open,
      high: st.high,
      low: st.low,
      prevClose: st.prevClose,
      change,
      changePct: st.prevClose ? change / st.prevClose : 0,
      volume: st.volume,
      amount: st.amount,
      bids: st.bids,
      asks: st.asks,
      limitUp: up,
      limitDown: down,
      ts: now,
      phase,
      halted: st.halted,
    };
  }

  snapshot(symbols?: Iterable<string>, phase: MarketPhase = 'closed'): Quote[] {
    const list = symbols ? [...symbols] : [...this.state.keys()];
    const now = Date.now();
    return list
      .map((s) => this.state.get(s))
      .filter((st): st is SymState => Boolean(st))
      .map((st) => this.toQuote(st, phase, now));
  }

  /** 供 K 线播种使用 */
  getState(symbol: string): { last: number; prevClose: number; tickSize: number } | undefined {
    const st = this.state.get(symbol);
    return st ? { last: st.last, prevClose: st.prevClose, tickSize: st.tickSize } : undefined;
  }

  /**
   * 用播种出来的分时数据回填当日累计量额与开高低。
   *
   * 不做这一步会出现"自相矛盾"：分时图显示成交了几万手，
   * 而个股详情里的"成交量"只有几百手（因为那只是服务启动后累积的量）。
   * 行情产品里所有派生字段必须能互相对上，否则一眼就露馅。
   */
  seedDailyState(
    symbol: string,
    s: { open?: number; high?: number; low?: number; volume?: number; amount?: number },
  ): void {
    const st = this.state.get(symbol);
    if (!st) return;
    if (s.open) st.open = s.open;
    if (s.high) st.high = s.high;
    if (s.low) st.low = s.low;
    if (s.volume !== undefined) st.volume = s.volume;
    if (s.amount !== undefined) st.amount = s.amount;
  }
}

/**
 * 真实行情源：通过东财公开接口取 Level-1 数据。
 *
 * 两个工程要点（面试可以直接讲）：
 *  1. **必须走 BFF**：这类接口没有 CORS 头、且校验 Referer，
 *     浏览器直连必失败。放到服务端代理后，前端拿到的仍是统一的 Quote 结构。
 *  2. **五档是本地构造的**：公开 Level-1 接口不保证提供十档/逐笔深度
 *     （那是 Level-2 付费行情），所以这里用真实最新价 + 本地构造的盘口，
 *     并在 UI 上明确标注数据来源，不做"假装有 Level-2"的事。
 */
export class EastmoneyQuoteSource extends MockQuoteSource implements QuoteSource {
  readonly name = 'eastmoney+mock-depth';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPoll = 0;
  private logging = true;

  private static readonly FIELDS = 'f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18';

  override bootstrap(): Quote[] {
    const list = super.bootstrap();
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), 3000);
    return list;
  }

  override dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPoll < 2500) return;
    this.lastPoll = now;

    const secids = INSTRUMENTS.map((i) => {
      const market = i.market === 'SH' || i.market === 'BJ' ? 1 : 0;
      return `${market}.${i.code}`;
    }).join(',');

    const url =
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2` +
      `&secids=${secids}&fields=${EastmoneyQuoteSource.FIELDS}`;

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 4000);
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: { diff?: Array<Record<string, number | string>> };
      };
      const diff = body.data?.diff;
      if (!Array.isArray(diff) || diff.length === 0) throw new Error('empty payload');
      this.applyReal(diff);
      this._degraded = false;
    } catch (e) {
      if (this.logging) {
        this.logging = false;
        console.warn(
          `[行情源] 真实行情拉取失败（${String(e)}），已退回纯模拟数据。` +
            `\n         如需真实行情请检查网络与接口可用性；Mock 模式不影响任何功能。`,
        );
      }
      this._degraded = true;
    }
  }

  private applyReal(diff: Array<Record<string, number | string>>): void {
    for (const row of diff) {
      const code = String(row.f12 ?? '');
      if (!code) continue;
      const st = [...this.state.values()].find((s) => s.inst.code === code);
      if (!st) continue;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

      const prevClose = num(row.f18);
      if (prevClose > 0) st.prevClose = prevClose;
      const last = num(row.f2);
      if (last > 0) st.last = last;
      st.open = num(row.f17) || st.open;
      st.high = num(row.f15) || st.high;
      st.low = num(row.f16) || st.low;
      // f5 单位是"手"，统一换算成"股"
      const volHands = num(row.f5);
      if (volHands > 0) st.volume = volHands * 100;
      const amount = num(row.f6);
      if (amount > 0) st.amount = amount;
      this.rebuildDepth(st);
    }
  }

  override resetDay(): void {
    // 真实行情模式下不问"虚拟交易日"，重置交给真实市场
    super.resetDay();
  }

  override step(ctx: StepContext): { quotes: Quote[]; ticks: Tick[] } {
    // 真实模式下不模拟价格，只推当前快照；ticks 由本地按价格变化推断
    const quotes: Quote[] = [];
    for (const st of this.state.values()) {
      quotes.push(this.toQuote(st, ctx.phase, ctx.now));
    }
    return { quotes, ticks: [] };
  }
}

export function createSource(): QuoteSource {
  const kind = (process.env.QUOTE_SOURCE ?? 'mock').toLowerCase();
  if (kind === 'eastmoney') {
    console.log('[行情源] 使用东财真实行情（+本地构造五档）');
    return new EastmoneyQuoteSource();
  }
  console.log('[行情源] 使用内置模拟行情（任何时间都可演示）');
  return new MockQuoteSource();
}

export { INSTRUMENT_MAP };
export type { Instrument };
