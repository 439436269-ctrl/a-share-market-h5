/**
 * 网络接线层：把 MarketConnection 的事件流接到 store 上。
 *
 * 刻意不放在 React 组件里 —— 连接是应用级单例，不应该随组件挂载/卸载重建。
 * 组件只负责"读 store"，不负责"管连接"。
 */
import { MarketConnection } from '@stock/market-client';
import type { Instrument } from '@stock/market-core';
import { marketStore, instrumentStore } from './store';
import { tradingStore } from './tradingStore';

/** 开发环境走 Vite 代理，生产环境同源，所以直接用当前 host 即可 */
function resolveWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export const connection = new MarketConnection({
  url: resolveWsUrl(),

  onStatus: (status, detail) => {
    marketStore.setStatus(status, detail);
    if (detail) marketStore.pushLog(`[连接] ${status} — ${detail}`);
    else marketStore.pushLog(`[连接] ${status}`);
  },

  onQuotes: (quotes) => {
    const touched = marketStore.applyQuotes(quotes);
    if (touched.length > 0 && import.meta.env.DEV) {
      // 开发期留痕：用于验证"只更新变化的标的"这一行为
      (window as unknown as { __lastTouched?: string[] }).__lastTouched = touched;
    }
  },

  onTicks: (ticks) => marketStore.applyTicks(ticks),

  onGap: (info) => {
    marketStore.pushLog(
      `[序号缺口] ${info.lastSeq} → ${info.gotSeq}（疑似丢 ${info.missed} 帧），已请求全量快照`,
    );
  },

  onStats: (stats) => marketStore.setStats(stats),

  log: (msg) => marketStore.pushLog(`[协议] ${msg}`),

  // ---- 交易私有回报：与行情走同一根连接，但属于另一套可靠性语义
  onTradingSnapshot: (snapshot) => {
    tradingStore.setSnapshot(snapshot);
    marketStore.pushLog(`[交易] 快照：委托 ${snapshot.orders.length} 笔 · 成交 ${snapshot.trades.length} 笔`);
  },
  onOrder: (order) => tradingStore.upsertOrder(order),
  onTrade: (trade) => {
    tradingStore.addTrade(trade);
    marketStore.pushLog(`[成交] ${trade.symbol} ${trade.side === 'buy' ? '买' : '卖'} ${trade.volume} 股 @ ${trade.price}`);
  },
  onAccount: (account) => tradingStore.setAccount(account),
});

/** 应用启动：拉主数据 + 自选列表，然后建连、订阅 */
export async function bootstrap(): Promise<void> {
  try {
    const [instRes, watchRes] = await Promise.all([
      fetch('/api/instruments'),
      fetch('/api/watchlist'),
    ]);
    const instruments = (await instRes.json()) as Instrument[];
    const watchlist = (await watchRes.json()) as string[];
    instrumentStore.set(instruments);
    marketStore.setWatchlist(watchlist);
    connection.connect();
    // 自选常驻订阅（走引用计数，详情页离开时不会把它退掉）
    watchlist.forEach((s) => acquire(s));
    marketStore.pushLog(`[启动] 载入 ${instruments.length} 个标的，自选 ${watchlist.length} 只`);
  } catch (e) {
    marketStore.pushLog(`[启动失败] ${String(e)}`);
  }
}

/**
 * 订阅引用计数。
 *
 * 为什么需要：详情页可能打开一只**不在自选里**的票，离开时要退订；
 * 但如果这只票同时在自选里，直接 unsub 会把自选的数据也切断。
 * 用引用计数，谁需要谁加一，最后一个释放才真正退订。
 */
const refCount = new Map<string, number>();

export function acquire(symbol: string): void {
  const next = (refCount.get(symbol) ?? 0) + 1;
  refCount.set(symbol, next);
  if (next === 1) connection.subscribe([symbol]);
}

export function release(symbol: string): void {
  const cur = refCount.get(symbol) ?? 0;
  if (cur <= 1) {
    refCount.delete(symbol);
    connection.unsubscribe([symbol]);
  } else {
    refCount.set(symbol, cur - 1);
  }
}


/** 拉取 K 线（走 REST，不进 WS —— 历史数据不该占实时链路） */
export async function fetchKline(
  symbol: string,
  period: string,
  limit = 240,
): Promise<import('@stock/market-core').Bar[]> {
  const res = await fetch(`/api/kline?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { bars?: import('@stock/market-core').Bar[] };
  return body.bars ?? [];
}
