/**
 * A 股交易时段与状态机。
 *
 * 为什么必须放在共享层：
 * 前端"现在能不能下单"、BFF"要不要推行情"、模拟器"该走哪个阶段"，
 * 必须用同一套判定，否则会出现"服务端说收盘了、前端按钮还是亮的"这类事故。
 *
 * 注意：真实系统这里读的是**交易所交易日历**（含节假日、临时休市、半日市），
 * 下面的 HOLIDAYS 只是占位，生产环境要换成交易日历服务。
 */

/** 中国无夏令时，恒定 UTC+8 */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 占位：真实系统应从交易日历获取（格式 YYYY-MM-DD） */
export const HOLIDAYS = new Set<string>([]);

export interface CnParts {
  date: string; // YYYY-MM-DD
  weekday: number; // 0=周日
  seconds: number; // 当日秒数
  hhmm: string;
}

/** 把任意时刻换算成"北京墙上时间"的字段（用 UTC getter 读取，规避本地时区） */
export function cnParts(at: number | Date = Date.now()): CnParts {
  const ms = (typeof at === 'number' ? at : at.getTime()) + CN_OFFSET_MS;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return {
    date: `${y}-${m}-${day}`,
    weekday: d.getUTCDay(),
    seconds: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
    hhmm: `${hh}:${mm}`,
  };
}

/** 是否交易日（周一~周五且不在节假日表） */
export function isTradingDay(at: number | Date = Date.now()): boolean {
  const { weekday, date } = cnParts(at);
  if (weekday === 0 || weekday === 6) return false;
  return !HOLIDAYS.has(date);
}

const T = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s;

/**
 * 判定当前交易阶段。
 *
 * A 股一天的时间线（沪深两市）：
 *   09:15-09:20 集合竞价（可撤单）
 *   09:20-09:25 集合竞价（不可撤单）
 *   09:25-09:30 开盘价已产生，等待连续竞价
 *   09:30-11:30 连续竞价（上午）
 *   11:30-13:00 午间休市
 *   13:00-14:57 连续竞价（下午）
 *   14:57-15:00 收盘集合竞价
 */
export function phaseOf(at: number | Date = Date.now()) {
  if (!isTradingDay(at)) return 'closed' as const;
  const { seconds } = cnParts(at);

  if (seconds < T(9, 15)) return 'pre_open' as const;
  if (seconds < T(9, 25)) return 'call_auction' as const;
  if (seconds < T(9, 30)) return 'pre_match' as const;
  if (seconds < T(11, 30)) return 'continuous' as const;
  if (seconds < T(13, 0)) return 'lunch_break' as const;
  if (seconds < T(14, 57)) return 'continuous' as const;
  if (seconds < T(15, 0)) return 'close_auction' as const;
  return 'closed' as const;
}

/** 是否处于可撤单的集合竞价窗口（09:15-09:20）—— 下单/撤单 UI 会用到 */
export function canCancelInAuction(at: number | Date = Date.now()): boolean {
  const { seconds } = cnParts(at);
  return seconds >= T(9, 15) && seconds < T(9, 20);
}

/** 是否可交易（连续竞价或收盘集合竞价） */
export function isTradable(at: number | Date = Date.now()): boolean {
  const p = phaseOf(at);
  return p === 'continuous' || p === 'close_auction';
}

/** 全天 240 个交易分钟（上午 120 + 下午 120） */
export const SESSION_MINUTES = 240;

/**
 * 当前时刻在当日的"交易分钟序号"（0..239）。
 * 分时图的 x 轴就靠它 —— 直接把时间映射到第几个点，午休不占位。
 * @returns -1 表示不在交易时段内
 */
export function sessionMinuteIndex(at: number | Date = Date.now()): number {
  const { seconds } = cnParts(at);
  const open1 = T(9, 30);
  const close1 = T(11, 30);
  const open2 = T(13, 0);
  if (seconds >= open1 && seconds < close1) {
    return Math.floor((seconds - open1) / 60);
  }
  if (seconds >= open2 && seconds < T(15, 0)) {
    return 120 + Math.floor((seconds - open2) / 60);
  }
  return -1;
}
