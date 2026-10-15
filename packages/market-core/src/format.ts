/**
 * 金融数据的"显示层"坑点集中地。
 *
 * 这些函数看着琐碎，但都是行情产品里真实踩过的：
 * - 价格精度：A 股 2 位、部分标的需要 3 位，不能一路 toFixed(2)
 * - 成交量单位：交易所给的是"股"，中国用户习惯看"手"（1 手 = 100 股）
 * - 金额单位：万 / 亿 分级，且要保留有效数字
 * - 涨跌色：**中国市场是红涨绿跌**，与欧美相反，写反了会被一眼看出不懂业务
 */
import type { Instrument, Quote } from './types';

/** 涨跌方向 —— 直接映射到 CSS 类 */
export type Dir = 'up' | 'down' | 'flat';

export function dirOf(v: number): Dir {
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}

/** 涨跌色类名：红涨绿跌 */
export function dirClass(v: number): string {
  return `dir-${dirOf(v)}`;
}

/** 价格格式化：0 视作"无数据"（停牌 / 未开盘），显示占位符 */
export function fmtPrice(v: number | undefined, digits = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v) || v === 0) return '--';
  return v.toFixed(digits);
}

/** 带符号涨跌额 */
export function fmtChange(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '--';
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

/** 带符号涨跌幅，入参是小数（0.0123 → +1.23%） */
export function fmtPct(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '--';
  const s = (v * 100).toFixed(digits);
  return v > 0 ? `+${s}%` : `${s}%`;
}

/**
 * 成交量格式化：入参单位是"股"。
 * 输出带"手"语义 —— 这是证券行业的默认口径。
 */
export function fmtVolume(shares: number, digits = 2): string {
  if (!Number.isFinite(shares) || shares <= 0) return '--';
  const hands = shares / 100; // 股 → 手
  if (hands < 10_000) return `${Math.round(hands)}手`;
  if (hands < 100_000_000) return `${(hands / 10_000).toFixed(digits)}万手`;
  return `${(hands / 100_000_000).toFixed(digits)}亿手`;
}

/** 成交额格式化：入参单位是"元" */
export function fmtAmount(yuan: number, digits = 2): string {
  if (!Number.isFinite(yuan) || yuan <= 0) return '--';
  if (yuan < 10_000) return `${yuan.toFixed(0)}元`;
  if (yuan < 100_000_000) return `${(yuan / 10_000).toFixed(digits)}万`;
  return `${(yuan / 100_000_000).toFixed(digits)}亿`;
}

/** 换手率 = 成交量 / 流通股本 */
export function turnoverRate(q: Quote, inst: Instrument | undefined): number {
  if (!inst || !inst.floatShares) return 0;
  return q.volume / inst.floatShares;
}

/** 振幅 = (最高 - 最低) / 昨收 */
export function amplitude(q: Quote): number {
  if (!q.prevClose) return 0;
  return (q.high - q.low) / q.prevClose;
}

/** 涨跌停价：A 股按昨收 × (1 ± 幅度) 四舍五入到分 */
export function limitPrices(prevClose: number, limitPct: number): { up: number; down: number } {
  if (!limitPct) return { up: 0, down: 0 };
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return { up: round2(prevClose * (1 + limitPct)), down: round2(prevClose * (1 - limitPct)) };
}

/** 是否已封涨停 / 跌停 */
export function isLimitUp(q: Quote): boolean {
  return q.limitUp > 0 && q.last >= q.limitUp - 0.001;
}
export function isLimitDown(q: Quote): boolean {
  return q.limitDown > 0 && q.last <= q.limitDown + 0.001;
}

/** 沪深市场配色下的"涨跌停"标签 */
export function limitLabel(q: Quote): string | null {
  if (q.halted) return '停牌';
  if (isLimitUp(q)) return '涨停';
  if (isLimitDown(q)) return '跌停';
  return null;
}

/** 交易状态的中文展示 */
export const PHASE_LABEL: Record<Quote['phase'], string> = {
  pre_open: '开盘前',
  call_auction: '集合竞价',
  pre_match: '待开盘',
  continuous: '交易中',
  lunch_break: '午间休市',
  close_auction: '收盘集合竞价',
  closed: '已收盘',
};

/** 客户端本地时间格式化（行情时间戳用交易所时区语义，展示为 HH:mm:ss） */
export function fmtTime(ts: number, withSeconds = true): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${hhmm}:${p(d.getSeconds())}` : hhmm;
}
