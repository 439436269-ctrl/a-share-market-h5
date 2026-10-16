/**
 * 交易状态容器与接口。
 *
 * 刻意与 `store.ts`（行情）分开，理由不只是"文件太长"：
 *
 * 1. **更新频率差两个数量级**：行情 2 帧/秒、交易回报偶尔几条。
 *    资金持仓为了账面市值实时，是约 1 秒推一次。如果共用一个订阅集合，
 *    每秒一次的账户推送会把委托列表和成交列表也带着重渲染 —— 三条数据线各有各的节奏，
 *    就该各有各的订阅。
 * 2. **可靠性语义不同**：行情可丢可补，交易回报必须逐条送达（见 protocol.ts 的说明）。
 *
 * 所以这里用三套独立的监听集合：orders / trades / account，谁变通知谁。
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Account, Order, OrderSide, OrderType, Position, Trade } from '@stock/market-core';

type Listener = () => void;

const EMPTY_ORDERS: Order[] = [];
const EMPTY_TRADES: Trade[] = [];

class TradingStore {
  private orders: Order[] = EMPTY_ORDERS;
  private readonly orderListeners = new Set<Listener>();

  private trades: Trade[] = EMPTY_TRADES;
  private readonly tradeListeners = new Set<Listener>();

  private account: Account | null = null;
  private readonly accountListeners = new Set<Listener>();

  // ---------------------------------------------------------------- 写入

  /** 建连时服务端推的交易快照 */
  setSnapshot(snapshot: { orders: Order[]; trades: Trade[]; account: Account }): void {
    this.orders = sortOrders(snapshot.orders);
    this.trades = snapshot.trades.slice(0, 200);
    this.account = snapshot.account;
    this.orderListeners.forEach((fn) => fn());
    this.tradeListeners.forEach((fn) => fn());
    this.accountListeners.forEach((fn) => fn());
  }

  /** 委托状态变更：按 orderId 覆盖，保持"最新在前" */
  upsertOrder(order: Order): void {
    const idx = this.orders.findIndex((o) => o.orderId === order.orderId);
    if (idx < 0) {
      this.orders = sortOrders([order, ...this.orders]);
    } else {
      const next = [...this.orders];
      next[idx] = order;
      this.orders = next;
    }
    this.orderListeners.forEach((fn) => fn());
  }

  addTrade(trade: Trade): void {
    this.trades = [trade, ...this.trades].slice(0, 200);
    this.tradeListeners.forEach((fn) => fn());
  }

  setAccount(account: Account): void {
    this.account = account;
    this.accountListeners.forEach((fn) => fn());
  }

  // ---------------------------------------------------------------- 读取

  getOrders(): Order[] {
    return this.orders;
  }

  getTrades(): Trade[] {
    return this.trades;
  }

  getAccount(): Account | null {
    return this.account;
  }

  getPosition(symbol: string): Position | undefined {
    return this.account?.positions.find((p) => p.symbol === symbol);
  }

  // ---------------------------------------------------------------- 订阅

  subscribeOrders(fn: Listener): () => void {
    this.orderListeners.add(fn);
    return () => this.orderListeners.delete(fn);
  }

  subscribeTrades(fn: Listener): () => void {
    this.tradeListeners.add(fn);
    return () => this.tradeListeners.delete(fn);
  }

  subscribeAccount(fn: Listener): () => void {
    this.accountListeners.add(fn);
    return () => this.accountListeners.delete(fn);
  }
}

function sortOrders(list: Order[]): Order[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

export const tradingStore = new TradingStore();

// -------------------------------------------------------------------- Hooks

export function useOrders(): Order[] {
  return useSyncExternalStore(
    useCallback((fn: Listener) => tradingStore.subscribeOrders(fn), []),
    useCallback(() => tradingStore.getOrders(), []),
  );
}

export function useTrades(): Trade[] {
  return useSyncExternalStore(
    useCallback((fn: Listener) => tradingStore.subscribeTrades(fn), []),
    useCallback(() => tradingStore.getTrades(), []),
  );
}

export function useAccount(): Account | null {
  return useSyncExternalStore(
    useCallback((fn: Listener) => tradingStore.subscribeAccount(fn), []),
    useCallback(() => tradingStore.getAccount(), []),
  );
}

// -------------------------------------------------------------------- 接口

export interface SubmitOrderRequest {
  /** 幂等键。**重试必须复用同一个** —— 这是防重复下单的唯一抓手 */
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  volume: number;
}

export interface TradingActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  order?: Order;
  /** 服务端判定为幂等命中（说明这次请求只是重试，没有真的又下一单） */
  deduplicated?: boolean;
}

export async function submitOrder(req: SubmitOrderRequest): Promise<TradingActionResult> {
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        code: String(body.code ?? 'UNKNOWN'),
        message: String(body.message ?? '下单失败'),
        order: body.order as Order | undefined,
      };
    }
    return {
      ok: true,
      order: body.order as Order,
      deduplicated: Boolean(body.deduplicated),
    };
  } catch {
    // 网络异常不等于失败：请求可能已经到达服务端。
    // 此时**绝不能换一个幂等键重发**，必须复用同一个，让服务端去重。
    return {
      ok: false,
      code: 'NETWORK',
      message: '网络异常，可用同一幂等键重试（不会重复下单）',
    };
  }
}

export async function cancelOrder(orderId: string): Promise<TradingActionResult> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, code: String(body.code ?? 'UNKNOWN'), message: String(body.message ?? '撤单失败') };
    }
    return { ok: true, order: body.order as Order, deduplicated: Boolean(body.deduplicated) };
  } catch {
    return { ok: false, code: 'NETWORK', message: '网络异常，请稍后重试' };
  }
}

export interface TradingLimits {
  maxBuy: number;
  maxSell: number;
}

/** 最大可买/可卖由服务端算，避免整手规则与预留手续费在前端各算一遍导致口径错位 */
export async function fetchTradingLimits(symbol: string): Promise<TradingLimits> {
  try {
    const res = await fetch(`/api/trading/limits?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return { maxBuy: 0, maxSell: 0 };
    const body = (await res.json()) as TradingLimits;
    return { maxBuy: body.maxBuy ?? 0, maxSell: body.maxSell ?? 0 };
  } catch {
    return { maxBuy: 0, maxSell: 0 };
  }
}
