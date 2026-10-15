/**
 * 证券领域核心数据模型。
 *
 * 设计原则：这一层不依赖任何运行时（浏览器 / Node 通用），
 * 前端、BFF、测试三边共用同一套类型，避免"前后端字段理解不一致"这类典型事故。
 */

/** 市场标识 */
export type MarketId = 'SH' | 'SZ' | 'BJ' | 'HK';

/** 板块 —— 它直接决定涨跌停幅度，是行情校验的第一依据 */
export type Board = 'main' | 'gem' | 'star' | 'bj' | 'index';

/**
 * 交易状态机。
 * 行情 UI 里大量分支（能否下单、显示"集合竞价"/"已收盘"、涨跌幅基准）都由它驱动，
 * 所以它必须是协议的一等公民，而不是前端自己用本地时间猜。
 */
export type MarketPhase =
  | 'pre_open' // 开盘前
  | 'call_auction' // 集合竞价 09:15-09:25
  | 'pre_match' // 09:25-09:30 开盘价已定，等待开盘
  | 'continuous' // 连续竞价
  | 'lunch_break' // 午间休市
  | 'close_auction' // 14:57-15:00 收盘集合竞价
  | 'closed'; // 已收盘

/** 标的主数据（Instrument Master） */
export interface Instrument {
  /** 全局唯一标识，如 600519.SH */
  symbol: string;
  /** 交易所代码，如 600519 */
  code: string;
  name: string;
  market: MarketId;
  board: Board;
  /** 涨跌停幅度：0.1 / 0.2 / 0.3 / 0.05；0 表示无涨跌停（指数） */
  limitPct: number;
  /** 昨收 —— 涨跌幅与涨跌停价的基准价 */
  prevClose: number;
  /** 流通股本（股），用于计算换手率；指数为 0 */
  floatShares: number;
}

/** 盘口一档 */
export interface DepthLevel {
  price: number;
  /** 单位：股 */
  volume: number;
}

/** 快照行情（Snapshot）—— 交易所 Level-1 的核心数据形态 */
export interface Quote {
  symbol: string;
  /** 最新价 */
  last: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  /** 涨跌额 */
  change: number;
  /** 涨跌幅，0.0123 表示 +1.23% */
  changePct: number;
  /** 成交量（股） */
  volume: number;
  /** 成交额（元） */
  amount: number;
  /** 买五档，bids[0] = 买一 */
  bids: DepthLevel[];
  /** 卖五档，asks[0] = 卖一 */
  asks: DepthLevel[];
  limitUp: number;
  limitDown: number;
  /** 行情时间戳（交易所时钟，ms） */
  ts: number;
  phase: MarketPhase;
  /** 是否停牌 */
  halted: boolean;
}

/** 逐笔成交（Tick）—— Level-2 才有的高频数据形态 */
export interface Tick {
  symbol: string;
  price: number;
  /** 成交量（股） */
  volume: number;
  /** 主动方向：B 主动买 / S 主动卖 / N 中性（集合竞价集合撮合） */
  side: 'B' | 'S' | 'N';
  ts: number;
}

/** K 线 / 分时 Bar */
export interface Bar {
  /** bar 起始时间（ms） */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export type Period = '1m' | '5m' | '15m' | '30m' | '60m' | '1d';

export const PERIOD_MS: Record<Period, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '60m': 3_600_000,
  '1d': 86_400_000,
};

/** 连接状态 —— 前端顶部状态条直接消费它 */
export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'open' // 已连接且序号连续
  | 'resyncing' // 检测到序号缺口，正在补拉全量
  | 'reconnecting' // 断线，退避重连中
  | 'closed';
