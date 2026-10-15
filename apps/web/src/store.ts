/**
 * 行情状态容器 —— 细粒度订阅。
 *
 * ## 要解决的真实问题
 * 行情是"高频、局部变化"的推模式数据：每 500ms 来一帧，一帧里通常只有几只票在动。
 * 如果按常规写法把它塞进顶层 state，会变成：
 *
 *     一帧到达 → 顶层 setState → 整棵组件树 re-render → 30 个行组件全部重算
 *
 * 30 只票时看不出来，300 只自选 + 详情页同时开着就会直接掉帧。
 *
 * ## 解法
 * 把订阅粒度下沉到**单个标的**：`useQuote(symbol)` 只订阅这一只，
 * 别的票跳动时这个组件连 render 都不会被调度。
 * 底层用 `useSyncExternalStore` —— 它是 React 官方为"外部可变数据源"开的口子，
 * 天然支持撕裂（tearing）防护，比 useEffect + setState 的桥接方式更安全。
 *
 * 面试时可以这样验证：打开 React DevTools 的 Highlight updates，
 * 然后在控制台执行 `fetch('/api/debug/drop?rate=0')` 前后观察，
 * 会看到只有价格真的变了的那几行在闪。
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { ConnectionStatus, Instrument, Quote, Tick } from '@stock/market-core';
import type { MarketStats } from '@stock/market-client';

const MAX_TICKS_PER_SYMBOL = 30;
const MAX_LOGS = 60;

export interface StatusSnapshot {
  status: ConnectionStatus;
  detail?: string;
  stats: MarketStats | null;
}

export interface LogEntry {
  id: number;
  at: number;
  text: string;
}

type Listener = () => void;

class QuoteStore {
  private quotes = new Map<string, Quote>();
  private readonly quoteListeners = new Map<string, Set<Listener>>();

  private watchlist: string[] = [];
  private watchlistSnapshot: string[] = [];
  private readonly watchlistListeners = new Set<Listener>();

  private status: StatusSnapshot = { status: 'idle', stats: null };
  private readonly statusListeners = new Set<Listener>();

  private ticks = new Map<string, Tick[]>();
  private readonly tickListeners = new Map<string, Set<Listener>>();

  private logs: LogEntry[] = [];
  private logSeq = 0;
  private readonly logListeners = new Set<Listener>();

  // ---------------------------------------------------------------- 行情

  /**
   * 写入一帧行情。只有**真的发生变化**的标的才会通知订阅者 ——
   * 这是整个细粒度方案的第一道闸门，没有它后面全白搭。
   * @returns 本次真正更新的标的
   */
  applyQuotes(list: Quote[]): string[] {
    const touched: string[] = [];
    for (const q of list) {
      const prev = this.quotes.get(q.symbol);
      // 用 ts + last + volume 三个字段判等：任一变化才算新数据
      if (prev && prev.ts === q.ts && prev.last === q.last && prev.volume === q.volume) {
        continue;
      }
      this.quotes.set(q.symbol, q);
      touched.push(q.symbol);
    }
    for (const s of touched) this.quoteListeners.get(s)?.forEach((fn) => fn());
    return touched;
  }

  getQuote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  subscribeQuote(symbol: string, fn: Listener): () => void {
    let set = this.quoteListeners.get(symbol);
    if (!set) {
      set = new Set();
      this.quoteListeners.set(symbol, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  // ---------------------------------------------------------------- 逐笔

  applyTicks(list: Tick[]): void {
    const touched = new Set<string>();
    for (const t of list) {
      // 必须生成**新数组**而不是原地 unshift：
      // useSyncExternalStore 靠引用比较判断是否变化，原地改数组会让 UI 永远不刷新
      const prev = this.ticks.get(t.symbol) ?? EMPTY_TICKS;
      this.ticks.set(t.symbol, [t, ...prev].slice(0, MAX_TICKS_PER_SYMBOL));
      touched.add(t.symbol);
    }
    for (const s of touched) this.tickListeners.get(s)?.forEach((fn) => fn());
  }

  getTicks(symbol: string): Tick[] {
    return this.ticks.get(symbol) ?? EMPTY_TICKS;
  }

  subscribeTicks(symbol: string, fn: Listener): () => void {
    let set = this.tickListeners.get(symbol);
    if (!set) {
      set = new Set();
      this.tickListeners.set(symbol, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  // ---------------------------------------------------------------- 自选

  setWatchlist(symbols: string[]): void {
    if (sameArray(this.watchlist, symbols)) return;
    this.watchlist = [...symbols];
    this.watchlistSnapshot = [...symbols];
    this.watchlistListeners.forEach((fn) => fn());
  }

  getWatchlist(): string[] {
    return this.watchlistSnapshot;
  }

  subscribeWatchlist(fn: Listener): () => void {
    this.watchlistListeners.add(fn);
    return () => this.watchlistListeners.delete(fn);
  }

  // ---------------------------------------------------------------- 连接状态

  setStatus(status: ConnectionStatus, detail?: string): void {
    if (this.status.status === status && this.status.detail === detail) return;
    this.status = { ...this.status, status, detail };
    this.statusListeners.forEach((fn) => fn());
  }

  setStats(stats: MarketStats): void {
    this.status = { ...this.status, stats };
    this.statusListeners.forEach((fn) => fn());
  }

  getStatus(): StatusSnapshot {
    return this.status;
  }

  subscribeStatus(fn: Listener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  // ---------------------------------------------------------------- 诊断日志

  pushLog(text: string): void {
    this.logSeq += 1;
    this.logs = [{ id: this.logSeq, at: Date.now(), text }, ...this.logs].slice(0, MAX_LOGS);
    this.logListeners.forEach((fn) => fn());
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }

  subscribeLogs(fn: Listener): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }
}

const EMPTY_TICKS: Tick[] = [];

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 标的主数据（名称/板块/涨跌停幅度）—— 与 Quote 分开管理，加载一次就不再变 */
class InstrumentStore {
  private map = new Map<string, Instrument>();
  private snapshot: Map<string, Instrument> = new Map();
  private readonly listeners = new Set<Listener>();

  set(list: Instrument[]): void {
    this.map = new Map(list.map((i) => [i.symbol, i]));
    this.snapshot = this.map;
    this.listeners.forEach((fn) => fn());
  }

  get(symbol: string): Instrument | undefined {
    return this.map.get(symbol);
  }

  getSnapshot(): Map<string, Instrument> {
    return this.snapshot;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const marketStore = new QuoteStore();
export const instrumentStore = new InstrumentStore();

// -------------------------------------------------------------------- Hooks

/** 订阅单只标的的行情。只有这只票变化时，调用组件才会重新渲染。 */
export function useQuote(symbol: string): Quote | undefined {
  return useSyncExternalStore(
    useCallback((fn: Listener) => marketStore.subscribeQuote(symbol, fn), [symbol]),
    useCallback(() => marketStore.getQuote(symbol), [symbol]),
  );
}

export function useWatchlist(): string[] {
  return useSyncExternalStore(
    useCallback((fn: Listener) => marketStore.subscribeWatchlist(fn), []),
    useCallback(() => marketStore.getWatchlist(), []),
  );
}

export function useTicks(symbol: string): Tick[] {
  return useSyncExternalStore(
    useCallback((fn: Listener) => marketStore.subscribeTicks(symbol, fn), [symbol]),
    useCallback(() => marketStore.getTicks(symbol), [symbol]),
  );
}

export function useStatus(): StatusSnapshot {
  return useSyncExternalStore(
    useCallback((fn: Listener) => marketStore.subscribeStatus(fn), []),
    useCallback(() => marketStore.getStatus(), []),
  );
}

export function useLogs(): LogEntry[] {
  return useSyncExternalStore(
    useCallback((fn: Listener) => marketStore.subscribeLogs(fn), []),
    useCallback(() => marketStore.getLogs(), []),
  );
}

export function useInstruments(): Map<string, Instrument> {
  return useSyncExternalStore(
    useCallback((fn: Listener) => instrumentStore.subscribe(fn), []),
    useCallback(() => instrumentStore.getSnapshot(), []),
  );
}

export { instrumentStore as instruments };
