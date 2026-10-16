/**
 * 交易服务：账户、持仓、委托、撮合、成交回报。
 *
 * ## 职责边界
 * 这是委托与持仓的**唯一写入方**。REST（下单/撤单）和 WS（回报推送）都只是它的出入口 ——
 * 状态变更只有一处发生，就不需要锁，也不会出现"两个入口各改一半"的问题
 * （Node 单线程 + 单一写入方，这是最省心的一致性模型）。
 *
 * ## 撮合模型（贴近真实，但刻意简化）
 * 真实撮合在交易所，这里在服务端本地对着**当前盘口**撮：
 *   - 限价单：只有对手价满足委托价才成交（买：卖一 ≤ 委托价；卖：买一 ≥ 委托价）
 *   - 市价单（对手方最优）：吃对手盘五档，剩余部分撤销（"最优五档即时成交剩余撤销"语义）
 *   - 未成交部分挂单，随后**每一帧行情到来时重新撮合** —— 所以挂一个低于市价的买单，
 *     等价格走过来就会成交，并在前端看到实时成交回报
 *
 * ## 资金与持仓的两套冻结
 *   买入 → 冻结**资金**（金额 + 费用），成交时按比例释放，差额退回可用
 *   卖出 → 冻结**股份**（从 available 扣减，volume 不动），成交时 volume 减少、资金到账
 * 终结（成交完/撤单）时必须把剩余冻结释放干净，否则"可用资金"会永久漏掉一块 —— 这是最常见的账务 bug。
 */
import {
  calcFee,
  floorToLot,
  isCancelable,
  lotRuleOf,
  validateOrder,
} from '@stock/market-core';
import type {
  Account,
  Instrument,
  Order,
  OrderDraft,
  Position,
  Quote,
  Trade,
} from '@stock/market-core';
import { INSTRUMENT_MAP } from './instruments';

const round2 = (v: number) => Math.round(v * 100) / 100;

/** 初始资金与底仓（底仓带 available，否则 T+1 下没法演示卖出） */
export const INITIAL_CASH = 1_000_000;
const INITIAL_POSITIONS: Array<{ symbol: string; volume: number; cost: number }> = [
  { symbol: '600519.SH', volume: 200, cost: 1452.3 },
  { symbol: '300750.SZ', volume: 500, cost: 246.8 },
  { symbol: '000001.SZ', volume: 2000, cost: 11.05 },
];

/**
 * 本金基数 = 初始现金 + 底仓成本。
 *
 * 只拿现金当本金是错的：底仓成本会被整体算成"盈利"。
 * 本机实测就出现过"一进来累计盈亏 +43 万"的荒唐数字 —— 那正好等于底仓成本。
 */
const INITIAL_POSITION_COST = INITIAL_POSITIONS.reduce((sum, p) => sum + p.cost * p.volume, 0);
export const INITIAL_BASE = round2(INITIAL_CASH + INITIAL_POSITION_COST);

/** 是否启用 T+1（当日买入不可卖）。A 股实盘为 T+1，默认开启 */
const T1_ENABLED = (process.env.T1 ?? '1') !== '0';

export interface TradingEvents {
  onOrder(order: Order): void;
  onTrade(trade: Trade): void;
  onAccount(account: Account): void;
}

interface PositionState {
  /** 总持仓（股） */
  volume: number;
  /** 可用（T+1 当日买入不增加） */
  available: number;
  /** 摊薄成本价（含费用） */
  cost: number;
}

export type SubmitResult =
  | { ok: true; order: Order; deduplicated: boolean }
  | { ok: false; code: string; message: string; order: Order };

export type CancelResult =
  | { ok: true; order: Order; deduplicated: boolean }
  | { ok: false; code: string; message: string };

export class TradingService {
  private readonly orders = new Map<string, Order>();
  /** 幂等表：clientOrderId → orderId。防重复下单的唯一抓手 */
  private readonly byClientId = new Map<string, string>();
  /** 幂等键对应的请求指纹：同一 key 换了参数必须拒绝，而不是静默返回旧单 */
  private readonly fingerprint = new Map<string, string>();
  private trades: Trade[] = [];

  private cash = INITIAL_CASH;
  private frozen = 0;
  private readonly positions = new Map<string, PositionState>();
  /** 最新行情快照，由网关每帧灌入 */
  private readonly quotes = new Map<string, Quote>();

  private orderSeq = 0;
  private tradeSeq = 0;

  constructor(private readonly events: TradingEvents) {
    for (const p of INITIAL_POSITIONS) {
      this.positions.set(p.symbol, { volume: p.volume, available: p.volume, cost: p.cost });
    }
  }

  // ------------------------------------------------------------------ 行情

  /** 网关每帧调用：更新行情快照并重撮挂单 */
  onQuotes(quotes: Quote[]): void {
    for (const q of quotes) this.quotes.set(q.symbol, q);
    for (const order of this.orders.values()) {
      if (!isCancelable(order)) continue;
      const q = this.quotes.get(order.symbol);
      if (q) this.match(order, q, q.ts);
    }
  }

  getQuote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  // ------------------------------------------------------------------ 查询

  getOrders(): Order[] {
    // 最新委托在前
    return [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getTrades(): Trade[] {
    return [...this.trades].sort((a, b) => b.at - a.at);
  }

  getAccount(): Account {
    const positions: Position[] = [];
    let marketValue = 0;
    for (const [symbol, p] of this.positions) {
      if (p.volume <= 0 && p.available <= 0) continue;
      const last = this.quotes.get(symbol)?.last ?? p.cost;
      const mv = round2(last * p.volume);
      const costAmount = p.cost * p.volume;
      const pnl = round2(mv - costAmount);
      marketValue += mv;
      positions.push({
        symbol,
        volume: p.volume,
        available: p.available,
        costPrice: round2(p.cost),
        last,
        marketValue: mv,
        pnl,
        pnlPct: costAmount > 0 ? pnl / costAmount : 0,
      });
    }
    positions.sort((a, b) => b.marketValue - a.marketValue);
    const totalAsset = round2(this.cash + this.frozen + marketValue);
    return {
      cash: this.cash,
      frozen: this.frozen,
      marketValue: round2(marketValue),
      totalAsset,
      totalPnl: round2(totalAsset - INITIAL_BASE),
      positions,
    };
  }

  /** 建连时推给客户端的交易快照 */
  snapshot(): { orders: Order[]; trades: Trade[]; account: Account } {
    return { orders: this.getOrders(), trades: this.getTrades(), account: this.getAccount() };
  }

  // ------------------------------------------------------------------ 下单

  submitOrder(
    req: OrderDraft & { clientOrderId: string },
    now: number,
  ): SubmitResult {
    const symbol = req.symbol;
    const instrument: Instrument | undefined = INSTRUMENT_MAP.get(symbol);
    const quote = this.quotes.get(symbol);

    // ---- 幂等：#1 同一个 clientOrderId 且参数一致 → 直接返回原委托
    const print = fingerprintOf(req);
    const existingId = this.byClientId.get(req.clientOrderId);
    if (existingId) {
      const existing = this.orders.get(existingId);
      if (existing && this.fingerprint.get(req.clientOrderId) === print) {
        return { ok: true, order: { ...existing, deduplicated: true }, deduplicated: true };
      }
      // 同一个 key 换了参数：这是客户端 bug，必须显式报错而不是静默成功
      return {
        ok: false,
        code: 'CLIENT_ORDER_ID_CONFLICT',
        message: '该客户端订单号已用于另一笔委托，请勿复用',
        order: existing ?? this.makeRejected(req, 'CLIENT_ORDER_ID_CONFLICT', now),
      };
    }

    const availableVolume = this.positions.get(symbol)?.available ?? 0;
    const result = validateOrder(req, {
      instrument,
      quote,
      account: this.getAccount(),
      availableVolume,
    });

    // ---- 校验失败也落一条"废单"：用户必须能在委托列表里看到为什么没成
    if (!result.ok) {
      const rejected = this.makeRejected(req, result.message, now);
      this.orders.set(rejected.orderId, rejected);
      this.byClientId.set(req.clientOrderId, rejected.orderId);
      this.fingerprint.set(req.clientOrderId, print);
      this.events.onOrder(rejected);
      return { ok: false, code: result.code, message: result.message, order: rejected };
    }

    // ---- 冻结
    if (req.side === 'buy') {
      this.cash = round2(this.cash - result.frozenAmount);
      this.frozen = round2(this.frozen + result.frozenAmount);
    } else {
      const pos = this.positions.get(symbol)!;
      pos.available -= req.volume; // 冻结股份：available 扣减，volume 不动
    }

    const order: Order = {
      orderId: this.nextOrderId(),
      clientOrderId: req.clientOrderId,
      symbol,
      side: req.side,
      type: req.type,
      price: req.type === 'limit' ? req.price : result.refPrice,
      volume: req.volume,
      filledVolume: 0,
      avgPrice: 0,
      status: 'pending_new',
      frozenAmount: req.side === 'buy' ? result.frozenAmount : 0,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.orderId, order);
    this.byClientId.set(req.clientOrderId, order.orderId);
    this.fingerprint.set(req.clientOrderId, print);

    // 待报 → 已报，是两次独立的回报（真实系统里交易所回报也是异步的）
    this.events.onOrder({ ...order });
    this.events.onAccount(this.getAccount());

    // ---- 立即尝试撮合
    if (quote) this.match(order, quote, now);

    return { ok: true, order: { ...order }, deduplicated: false };
  }

  private makeRejected(req: OrderDraft & { clientOrderId: string }, reason: string, now: number): Order {
    return {
      orderId: this.nextOrderId(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      price: req.price,
      volume: req.volume,
      filledVolume: 0,
      avgPrice: 0,
      status: 'rejected',
      rejectReason: reason,
      frozenAmount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  // ------------------------------------------------------------------ 撤单

  cancelOrder(orderId: string, now: number): CancelResult {
    const order = this.orders.get(orderId);
    if (!order) return { ok: false, code: 'ORDER_NOT_FOUND', message: '委托不存在' };

    // 已撤的单再撤一次是幂等的：客户端重试不该报错
    if (order.status === 'canceled') return { ok: true, order: { ...order }, deduplicated: true };
    if (order.status === 'filled') {
      return { ok: false, code: 'ORDER_ALREADY_FILLED', message: '该委托已全部成交，无法撤单' };
    }
    if (order.status === 'rejected') {
      return { ok: false, code: 'ORDER_REJECTED', message: '废单无需撤单' };
    }

    this.releaseRemaining(order);
    order.status = 'canceled';
    order.updatedAt = now;

    this.events.onOrder({ ...order });
    this.events.onAccount(this.getAccount());
    return { ok: true, order: { ...order }, deduplicated: false };
  }

  /** 释放该委托剩余的冻结（资金或股份）—— 终结路径必须调用，否则账会漏 */
  private releaseRemaining(order: Order): void {
    if (order.side === 'buy') {
      if (order.frozenAmount > 0) {
        this.cash = round2(this.cash + order.frozenAmount);
        this.frozen = round2(this.frozen - order.frozenAmount);
        order.frozenAmount = 0;
      }
      return;
    }
    const remaining = order.volume - order.filledVolume;
    if (remaining > 0) {
      const pos = this.positions.get(order.symbol);
      if (pos) pos.available += remaining;
    }
  }

  // ------------------------------------------------------------------ 撮合

  /** 对着当前盘口撮合；限价单不满足价格就停，市价单吃完五档后撤销剩余 */
  private match(order: Order, quote: Quote, now: number): void {
    let remaining = order.volume - order.filledVolume;
    if (remaining <= 0) return;

    const levels = order.side === 'buy' ? quote.asks : quote.bids;
    let filledAny = false;

    for (const level of levels) {
      if (remaining <= 0) break;
      if (!level.price || level.volume <= 0) continue;

      if (order.type === 'limit') {
        if (order.side === 'buy' && level.price > order.price + 1e-9) break;
        if (order.side === 'sell' && level.price < order.price - 1e-9) break;
      }

      const qty = Math.min(remaining, level.volume);
      if (qty <= 0) continue;
      this.fill(order, level.price, qty, now);
      remaining -= qty;
      filledAny = true;
    }

    if (!filledAny) {
      // 受理了但没成交 → 挂单：待报 → 已报
      //
      // 这一步漏了就会出现"挂单永远显示待报"，状态机根本没走完。
      // 本机实测就是被 trading-test 抓出来的：远离市价的买单一直停在 pending_new。
      // 后续重撮时状态已是 new/partially_filled，这里天然幂等，不会重复推回报。
      if (order.status === 'pending_new') {
        order.status = 'new';
        order.updatedAt = now;
        this.events.onOrder({ ...order });
      }
      return;
    }

    if (order.filledVolume >= order.volume) {
      order.status = 'filled';
      order.updatedAt = now;
      this.releaseRemaining(order); // 成交完，冻结应已归零；兜底清一次
      this.events.onOrder({ ...order });
    } else if (order.type === 'market-opponent') {
      // 市价单：五档吃完还没成交完 → 剩余撤销（"最优五档即时成交剩余撤销"语义）
      this.releaseRemaining(order);
      order.status = 'canceled';
      order.updatedAt = now;
      this.events.onOrder({ ...order });
    } else {
      order.status = 'partially_filled';
      order.updatedAt = now;
      this.events.onOrder({ ...order });
    }
    this.events.onAccount(this.getAccount());
  }

  /** 一笔成交：更新委托、账务、持仓，并抛出成交回报 */
  private fill(order: Order, price: number, qty: number, now: number): void {
    const amount = round2(price * qty);
    const fee = calcFee(order.side, amount);

    const remainingBefore = order.volume - order.filledVolume;
    // 加权成交均价
    const prevAmount = order.avgPrice * order.filledVolume;
    order.filledVolume += qty;
    order.avgPrice = round2((prevAmount + amount) / order.filledVolume);

    if (order.side === 'buy') {
      // 按比例释放冻结，再按实际成本扣款，差额退回可用
      const release = remainingBefore > 0 ? round2((order.frozenAmount * qty) / remainingBefore) : 0;
      order.frozenAmount = round2(order.frozenAmount - release);
      this.frozen = round2(this.frozen - release);
      this.cash = round2(this.cash + release - (amount + fee.total));

      const pos = this.positions.get(order.symbol) ?? { volume: 0, available: 0, cost: 0 };
      const newVolume = pos.volume + qty;
      pos.cost = newVolume > 0 ? (pos.cost * pos.volume + amount + fee.total) / newVolume : 0;
      pos.volume = newVolume;
      // T+1：当日买入不增加可用
      if (!T1_ENABLED) pos.available += qty;
      this.positions.set(order.symbol, pos);
    } else {
      const pos = this.positions.get(order.symbol);
      if (pos) pos.volume = Math.max(0, pos.volume - qty);
      this.cash = round2(this.cash + amount - fee.total);
    }

    const trade: Trade = {
      tradeId: `T${String(++this.tradeSeq).padStart(6, '0')}`,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      price,
      volume: qty,
      amount,
      fee: fee.total,
      at: now,
    };
    this.trades.push(trade);
    if (this.trades.length > 500) this.trades.splice(0, this.trades.length - 500);
    this.events.onTrade(trade);
  }

  // ------------------------------------------------------------------ 工具

  private nextOrderId(): string {
    return `O${String(++this.orderSeq).padStart(6, '0')}`;
  }

  /** 一键最大可买（前端"全仓"用它，避免前端自己算导致口径不一致） */
  maxBuyVolume(symbol: string): number {
    const instrument = INSTRUMENT_MAP.get(symbol);
    const quote = this.quotes.get(symbol);
    const rule = lotRuleOf(instrument?.board);
    if (!quote || !rule) return 0;
    const price = quote.asks[0]?.price || quote.last;
    if (!price) return 0;
    // 预留费用，避免"刚好买满却因手续费不足被拒"
    const budget = this.cash / 1.0003;
    return floorToLot(Math.floor(budget / price), rule);
  }

  /** 一键最大可卖 */
  maxSellVolume(symbol: string): number {
    return this.positions.get(symbol)?.available ?? 0;
  }
}

/** 请求指纹：用于识别"同一个幂等键换了参数" */
function fingerprintOf(req: OrderDraft): string {
  return [req.symbol, req.side, req.type, req.price, req.volume].join('|');
}
