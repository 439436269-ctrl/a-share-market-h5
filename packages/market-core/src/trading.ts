/**
 * 交易领域模型与**风控前置校验**。
 *
 * ## 为什么校验必须放在共享层
 * 下单校验最怕"两边各写一遍"：前端写完、后端再写一遍，规则一改就漂移，
 * 最后变成"前端说没问题、后端报废单"。这里把它做成**纯函数**，前后端跑同一份代码：
 *
 *   - 前端：`onChange` 就调一次，即时告诉用户"价格超出有效竞价范围"
 *   - 服务端：收到请求再调一次，作为**最终裁决**
 *
 * 前端校验只是体验，**服务端校验才是安全边界** —— 前端可以被绕过，这个认知是面试常问的点。
 *
 * ## 规则来源（A 股，规则随监管调整，这里标注依据便于复核）
 * - 涨跌停：主板 ±10% / ST ±5% / 创业板·科创板 ±20% / 北交所 ±30% / 指数无
 * - 价格笼子：连续竞价阶段限价申报，买入不高于基准价 ×102%、卖出不低于 ×98%
 *   （集合竞价不适用；基准价实务上取"即时最优对手价/最新成交价/前收盘"之一，这里简化为最新价）
 * - 申报单位：主板·创业板 100 股起、100 股整数倍；科创板 200 股起、超出部分 1 股递增；
 *   北交所 100 股起、1 股递增。零股卖出必须一次性卖出（故卖出不做整手校验）
 * - 费用：佣金（双向，万 2.5、最低 5 元）+ 印花税（卖出单边 0.05%）+ 过户费（双向 0.001%）
 * - T+1：当日买入的股票当日不可卖
 */
import type { Board, Instrument, MarketPhase, Quote } from './types';

// ---------------------------------------------------------------- 基础类型

export type OrderSide = 'buy' | 'sell';

/**
 * 委托类型。
 * 真实两市市价单类型并不相同（沪市有"最优五档即时成交剩余转限价"，深市还有"即时成交剩余撤销"、
 * "全额成交或撤销"），这里只实现跨市场都有的"对手方最优价格"，并在注释里标明差异 ——
 * 做交易页时必须按市场分别配置可选项，否则用户选了"市价"却报废单。
 */
export type OrderType = 'limit' | 'market-opponent';

export const ORDER_TYPE_TEXT: Record<OrderType, string> = {
  limit: '限价委托',
  'market-opponent': '对手方最优价格',
};

export type OrderStatus =
  | 'pending_new' // 待报（已受理，尚未到交易所）
  | 'new' // 已报（挂在订单簿）
  | 'partially_filled' // 部成
  | 'filled' // 已成
  | 'canceled' // 已撤
  | 'rejected'; // 废单

export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  pending_new: '待报',
  new: '已报',
  partially_filled: '部成',
  filled: '已成',
  canceled: '已撤',
  rejected: '废单',
};

/** 未终结的状态（这些才能撤单） */
export const ACTIVE_STATUSES: OrderStatus[] = ['pending_new', 'new', 'partially_filled'];

export interface Order {
  orderId: string;
  /** 幂等键：客户端生成，重试必须复用同一个 —— 这是防重复下单的唯一抓手 */
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** 限价单的委托价；市价单为下参考价（用于展示与冻结估算） */
  price: number;
  volume: number;
  filledVolume: number;
  /** 成交均价 */
  avgPrice: number;
  status: OrderStatus;
  /** 废单原因 */
  rejectReason?: string;
  /** 冻结资金（买单）或冻结股数（卖单） */
  frozenAmount: number;
  createdAt: number;
  updatedAt: number;
  /** 该委托是否因重复提交被幂等命中（仅接口返回时标记） */
  deduplicated?: boolean;
}

export interface Trade {
  tradeId: string;
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  price: number;
  volume: number;
  amount: number;
  /** 本笔成交产生的费用合计 */
  fee: number;
  at: number;
}

export interface Position {
  symbol: string;
  /** 总持仓（股） */
  volume: number;
  /** 可用（T+1：当日买入的部分不计入） */
  available: number;
  /** 成本价（含费用的摊薄成本） */
  costPrice: number;
  last: number;
  marketValue: number;
  /** 浮动盈亏 */
  pnl: number;
  pnlPct: number;
}

export interface Account {
  /** 可用资金 */
  cash: number;
  /** 冻结资金（挂单占用） */
  frozen: number;
  /** 持仓市值 */
  marketValue: number;
  /** 总资产 = 可用 + 冻结 + 市值 */
  totalAsset: number;
  /** 累计盈亏（相对初始本金） */
  totalPnl: number;
  positions: Position[];
}

// ---------------------------------------------------------------- 费用

export const FEE_CONFIG = {
  /** 佣金费率（双向） */
  commissionRate: 0.00025,
  /** 佣金最低收取 */
  commissionMin: 5,
  /** 印花税（卖出单边） */
  stampTaxRate: 0.0005,
  /** 过户费（双向，沪深均已统一） */
  transferFeeRate: 0.00001,
};

export interface FeeBreakdown {
  commission: number;
  stampTax: number;
  transferFee: number;
  total: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** 计算单笔成交费用。卖出多一笔印花税 —— 这是"短线成本"最直观的来源 */
export function calcFee(side: OrderSide, amount: number): FeeBreakdown {
  const commission = Math.max(FEE_CONFIG.commissionMin, round2(amount * FEE_CONFIG.commissionRate));
  const stampTax = side === 'sell' ? round2(amount * FEE_CONFIG.stampTaxRate) : 0;
  const transferFee = round2(amount * FEE_CONFIG.transferFeeRate);
  return { commission, stampTax, transferFee, total: round2(commission + stampTax + transferFee) };
}

// ---------------------------------------------------------------- 申报单位

export interface LotRule {
  /** 最小申报数量 */
  min: number;
  /** 超出最小数量后的递增单位 */
  step: number;
}

/** 各板块申报单位（指数不可交易） */
export function lotRuleOf(board: Board | undefined): LotRule | null {
  switch (board) {
    case 'main':
    case 'gem':
      return { min: 100, step: 100 };
    case 'star':
      return { min: 200, step: 1 };
    case 'bj':
      return { min: 100, step: 1 };
    default:
      return null; // index：不可交易
  }
}

/** 数量是否满足申报单位 */
export function isLotAligned(volume: number, rule: LotRule): boolean {
  if (volume < rule.min) return false;
  return (volume - rule.min) % rule.step === 0;
}

/** 按申报单位向下取整到可申报数量（用于"全仓/半仓"快捷填充） */
export function floorToLot(volume: number, rule: LotRule): number {
  if (volume < rule.min) return 0;
  return rule.min + Math.floor((volume - rule.min) / rule.step) * rule.step;
}

// ---------------------------------------------------------------- 价格笼子

/** 价格笼子幅度：买入 ≤ 基准价×1.02，卖出 ≥ 基准价×0.98 */
export const PRICE_CAGE_PCT = 0.02;

/**
 * 价格笼子的基准价。
 * 实务上基准价是「即时最优对手价 → 最新成交价 → 前收盘价」依次取第一个有效的，
 * 这里简化为最新价（已足够表达机制），并在注释里留出升级位。
 */
export function priceCageBase(quote: Quote): number {
  return quote.last > 0 ? quote.last : quote.prevClose;
}

/** 给定买卖方向，返回价格笼子允许的区间（仅连续竞价阶段适用） */
export function priceCageRange(
  side: OrderSide,
  base: number,
): { min: number; max: number } {
  const lo = round2(base * (1 - PRICE_CAGE_PCT));
  const hi = round2(base * (1 + PRICE_CAGE_PCT));
  return side === 'buy' ? { min: 0, max: hi } : { min: lo, max: Number.POSITIVE_INFINITY };
}

// ---------------------------------------------------------------- 校验

export type OrderRejectCode =
  | 'NO_QUOTE'
  | 'OUT_OF_SESSION'
  | 'HALTED'
  | 'NOT_TRADABLE'
  | 'BAD_VOLUME'
  | 'LOT_SIZE'
  | 'BAD_PRICE'
  | 'PRICE_OUT_OF_LIMIT'
  | 'PRICE_CAGE'
  | 'INSUFFICIENT_CASH'
  | 'INSUFFICIENT_POSITION';

export interface ValidationContext {
  instrument: Instrument | undefined;
  quote: Quote | undefined;
  account: Account;
  /** 该标的当前可用数量（T+1 规则已由调用方折算好） */
  availableVolume: number;
}

export type ValidationResult =
  | {
      ok: true;
      /** 预计成交金额（按委托价或对手价估算） */
      estAmount: number;
      /** 预计费用 */
      fee: FeeBreakdown;
      /** 需要冻结的资金（买单） */
      frozenAmount: number;
      /** 校验通过时使用的参考价 */
      refPrice: number;
    }
  | { ok: false; code: OrderRejectCode; message: string };

export interface OrderDraft {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** 限价单必填；市价单可传 0 */
  price: number;
  volume: number;
}

/**
 * 下单校验（纯函数，前后端共用）。
 *
 * 顺序刻意按"从便宜到贵、从硬到软"排：先挡掉必然失败的，再算金额。
 * 返回结构化 code，前端据此做精确提示；服务端把 message 直接回给客户端。
 */
export function validateOrder(draft: OrderDraft, ctx: ValidationContext): ValidationResult {
  const { instrument, quote, account } = ctx;

  if (!instrument || !quote) {
    return { ok: false, code: 'NO_QUOTE', message: '暂无行情，无法委托' };
  }

  const phase: MarketPhase = quote.phase;
  // 交易所只在这两个阶段接受委托
  if (phase !== 'continuous' && phase !== 'close_auction' && phase !== 'call_auction') {
    return { ok: false, code: 'OUT_OF_SESSION', message: '非交易时段，无法委托' };
  }
  if (quote.halted) {
    return { ok: false, code: 'HALTED', message: '该标的停牌，无法委托' };
  }

  const rule = lotRuleOf(instrument.board);
  if (!rule) {
    return { ok: false, code: 'NOT_TRADABLE', message: '该标的不可交易（指数仅可查看）' };
  }

  if (!Number.isFinite(draft.volume) || draft.volume <= 0) {
    return { ok: false, code: 'BAD_VOLUME', message: '委托数量必须大于 0' };
  }
  // 卖出允许零股（零股必须一次性卖出），故只校验买入的整手规则
  if (draft.side === 'buy' && !isLotAligned(draft.volume, rule)) {
    return {
      ok: false,
      code: 'LOT_SIZE',
      message:
        rule.step === 1
          ? `该板块最小申报 ${rule.min} 股，超出部分可按 1 股递增`
          : `委托数量需为 ${rule.min} 股的整数倍`,
    };
  }

  if (draft.side === 'sell' && draft.volume > ctx.availableVolume) {
    return {
      ok: false,
      code: 'INSUFFICIENT_POSITION',
      message: `可用数量不足（可用 ${ctx.availableVolume} 股，T+1 当日买入不可卖）`,
    };
  }

  // ---- 价格
  if (draft.type === 'limit') {
    if (!Number.isFinite(draft.price) || draft.price <= 0) {
      return { ok: false, code: 'BAD_PRICE', message: '请输入委托价格' };
    }
    // 涨跌停是硬边界
    if (quote.limitUp > 0 && draft.price > quote.limitUp + 1e-9) {
      return { ok: false, code: 'PRICE_OUT_OF_LIMIT', message: `委托价不能高于涨停价 ${quote.limitUp}` };
    }
    if (quote.limitDown > 0 && draft.price < quote.limitDown - 1e-9) {
      return { ok: false, code: 'PRICE_OUT_OF_LIMIT', message: `委托价不能低于跌停价 ${quote.limitDown}` };
    }
    // 价格笼子只在连续竞价生效（集合竞价不适用）
    if (phase === 'continuous' && instrument.board !== 'index') {
      const base = priceCageBase(quote);
      const range = priceCageRange(draft.side, base);
      if (draft.price > range.max + 1e-9) {
        return {
          ok: false,
          code: 'PRICE_CAGE',
          message: `买入价不得高于基准价的 102%（≤ ${range.max}）`,
        };
      }
      if (draft.price < range.min - 1e-9) {
        return {
          ok: false,
          code: 'PRICE_CAGE',
          message: `卖出价不得低于基准价的 98%（≥ ${range.min}）`,
        };
      }
    }
  }

  // ---- 金额与资金
  const refPrice =
    draft.type === 'limit' ? draft.price : (draft.side === 'buy' ? quote.asks[0]?.price : quote.bids[0]?.price) || quote.last;
  if (!Number.isFinite(refPrice) || refPrice <= 0) {
    return { ok: false, code: 'BAD_PRICE', message: '对手盘无报价，无法估算成交价' };
  }

  const estAmount = round2(refPrice * draft.volume);
  const fee = calcFee(draft.side, estAmount);

  if (draft.side === 'buy') {
    // 买入需要冻结：成交金额 + 费用（卖出成交后再扣费，故不冻结）
    const frozenAmount = round2(estAmount + fee.total);
    if (frozenAmount > account.cash + 1e-6) {
      return {
        ok: false,
        code: 'INSUFFICIENT_CASH',
        message: `可用资金不足（需 ${frozenAmount.toFixed(2)} 元，可用 ${account.cash.toFixed(2)} 元）`,
      };
    }
    return { ok: true, estAmount, fee, frozenAmount, refPrice };
  }

  return { ok: true, estAmount, fee, frozenAmount: 0, refPrice };
}

// ---------------------------------------------------------------- 幂等键

/**
 * 生成客户端订单号（幂等键）。
 *
 * 使用时机很关键：**在用户打开确认弹层时生成一次**，之后无论重试多少次都复用它。
 * 如果每次重试都新生成一个，服务端的去重就完全失效 —— 弱网下必然重复下单。
 */
export function genClientOrderId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `c${Date.now().toString(36)}${rand}`;
}

/** 委托是否可撤 */
export function isCancelable(order: Order): boolean {
  return ACTIVE_STATUSES.includes(order.status);
}

/** 成交比例（用于进度条） */
export function fillRatio(order: Order): number {
  return order.volume > 0 ? order.filledVolume / order.volume : 0;
}
