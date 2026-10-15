/**
 * 虚拟时钟。
 *
 * 为什么需要它：行情 Demo 最大的尴尬是——**你演示的时候市场是关着的**。
 * 晚上、周末、节假日打开，页面一片死水，面试官看不到任何东西。
 *
 * 两种模式：
 *   live   —— 真实时间。盘中打开就是真实行情节奏。
 *   replay —— 虚拟时间以 N 倍速推进一整个交易日（默认 120 倍：1 秒 = 2 分钟），
 *             走到 15:00 自动翻到下一个交易日并从 09:15 重新开始。
 *             这样任何时刻打开都能看到"开盘→连续竞价→午休→收盘"的完整过程。
 */
import { cnParts, phaseOf } from '@stock/market-core';
import type { MarketPhase } from '@stock/market-core';

const CN_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

const T = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s;

/** 交易日时间线 */
export const SESSION_START = T(9, 15); // 集合竞价开始
export const SESSION_END = T(15, 0); // 收盘

/** 把"北京墙上时间的秒数"换算回 epoch（用于构造虚拟时刻） */
function cnWallToEpoch(dayStartUtcMs: number, secondsOfDay: number): number {
  return dayStartUtcMs + secondsOfDay * 1000 - CN_OFFSET_MS;
}

export type ClockMode = 'live' | 'replay';

export class SimClock {
  readonly mode: ClockMode;
  /** replay 模式下的倍速（虚拟秒 / 真实秒） */
  readonly speed: number;
  /** replay 模式的起始时刻（当日秒数），默认 09:15 */
  readonly startSeconds: number;

  private readonly startedAt = Date.now();
  /** 当前虚拟交易日（0 = 今天，往前推跳过周末） */
  private dayIndex = 0;
  /** 每个虚拟交易日的真实起点时间戳 */
  private dayAnchorReal = Date.now();
  /** 当前交易日的北京 00:00 对应的 epoch */
  private dayStartUtcMs: number;

  constructor(mode: ClockMode = 'replay', speed = 60, startSeconds = SESSION_START) {
    this.mode = mode;
    this.speed = speed;
    this.startSeconds = startSeconds;
    this.dayStartUtcMs = this.resolveTradingDayStart(Date.now(), 0);
  }

  /** 取 dayIndex 天前最近的一个交易日（跳过周末）的北京 00:00 */
  private resolveTradingDayStart(baseMs: number, backDays: number): number {
    let ms = baseMs - backDays * DAY_MS;
    // 跳过周六周日
    for (let guard = 0; guard < 10; guard++) {
      const { weekday } = cnParts(ms);
      if (weekday !== 0 && weekday !== 6) break;
      ms -= DAY_MS;
    }
    const { date } = cnParts(ms);
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }

  /** 当前时刻（live 模式即真实时间） */
  now(): number {
    if (this.mode === 'live') return Date.now();
    const elapsedReal = Date.now() - this.dayAnchorReal;
    const virtualSeconds = this.startSeconds + (elapsedReal * this.speed) / 1000;
    return cnWallToEpoch(this.dayStartUtcMs, virtualSeconds);
  }

  /** 当前交易阶段（由虚拟时刻推导，前后端同一套判定） */
  phase(): MarketPhase {
    return phaseOf(this.now());
  }

  /** 当前是第几个交易日（replay 模式下会随翻日递增） */
  get day(): number {
    return this.dayIndex;
  }

  /**
   * 是否需要翻到下一个交易日。
   * gateway 每帧调用一次；返回 true 时调用方应重置行情状态。
   */
  tickRollover(): boolean {
    if (this.mode === 'live') return false;
    const elapsedReal = Date.now() - this.dayAnchorReal;
    const virtualSeconds = this.startSeconds + (elapsedReal * this.speed) / 1000;
    if (virtualSeconds < SESSION_END) return false;
    // 翻日：锚点重置到当下，交易日往前推一天
    this.dayIndex += 1;
    this.dayAnchorReal = Date.now();
    this.dayStartUtcMs = this.resolveTradingDayStart(Date.now(), this.dayIndex);
    return true;
  }

  /** 供 /api/stats 与前端状态条展示 */
  describe(): { mode: ClockMode; speed: number; virtualTime: string; phase: MarketPhase; day: number } {
    const { hhmm, date } = cnParts(this.now());
    return {
      mode: this.mode,
      speed: this.speed,
      virtualTime: `${date} ${hhmm}`,
      phase: this.phase(),
      day: this.dayIndex,
    };
  }

  get uptimeMs(): number {
    return Date.now() - this.startedAt;
  }
}
