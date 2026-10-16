/**
 * 行情推送协议。
 *
 * 关键设计（面试重点）：
 * 1. 服务端是 **广播式帧（frame）** 模型：每 FRAME_MS 推一帧，帧内是增量 Quote，
 *    客户端订阅后本地过滤。这与真实行情网关（订阅后收 firehose）一致。
 * 2. 每一帧带**全局单调递增 seq**。客户端校验 seq 连续性即可发现丢包，
 *    发现缺口后主动发 resync 拉全量快照 —— 这就是"行情不能错"的兜底机制。
 * 3. 协议与编码分离：先上 JSON（可读、便于调试），
 *    Codec 接口预留二进制（Protobuf / 自定义二进制）实现，压测时对比。
 */
import type { Quote, Tick } from './types';
import type { Account, Order, Trade } from './trading';

export const PROTOCOL_VERSION = 1;

/** 服务端推帧间隔 */
export const FRAME_MS = 500;
/** 客户端心跳间隔 */
export const HEARTBEAT_MS = 15_000;
/** 心跳超时（超过即判定链路已死，强制重连） */
export const HEARTBEAT_TIMEOUT_MS = 40_000;

// ---------------------------------------------------------------- 客户端 → 服务端

export type ClientMessage =
  /** 订阅 / 追加订阅 */
  | { t: 'sub'; symbols: string[] }
  /** 取消订阅 */
  | { t: 'unsub'; symbols: string[] }
  /** 请求全量快照（检测到 seq 缺口、或重连恢复订阅后调用） */
  | { t: 'resync'; symbols: string[] }
  /** 心跳 */
  | { t: 'ping'; ts: number };

// ---------------------------------------------------------------- 服务端 → 客户端

export type ServerMessage =
  /** 建连欢迎帧：告知协议版本与心跳参数 */
  | { t: 'hello'; ver: number; serverTs: number; heartbeatMs: number; frameMs: number }
  /** 全量快照：seq 为该快照对应的当前帧序号，客户端以此为基线 */
  | { t: 'snapshot'; seq: number; quotes: Quote[] }
  /** 增量帧：只含本帧发生变化的标的 */
  | { t: 'delta'; seq: number; quotes: Quote[]; ticks: Tick[] }
  | { t: 'pong'; ts: number; serverTs: number }
  | { t: 'error'; code: string; message: string }
  // ---------------------------------------------------------------- 交易私有回报
  //
  // 注意：这些消息**刻意不参与行情帧的全局 seq 机制**。
  // 行情是广播、可容忍丢帧（丢了下一次全量补得回来）；
  // 交易回报是**用户私有事件**，丢一条用户看到的委托状态就是错的，必须逐条送达。
  // 所以两者走同一根 WebSocket，但属于两套不同的可靠性语义 —— 混在一起才是错的。
  // （生产系统通常还会给回报单独加序号与补拉接口；这里以建连时的交易快照作为恢复路径。）
  /** 建连后的交易快照：委托 / 成交 / 资金持仓 */
  | { t: 'trading'; orders: Order[]; trades: Trade[]; account: Account }
  /** 委托状态变更回报 */
  | { t: 'order'; order: Order }
  /** 成交回报 */
  | { t: 'trade'; trade: Trade }
  /** 资金与持仓变更回报 */
  | { t: 'account'; account: Account };

// ---------------------------------------------------------------- 编解码

export interface Codec {
  readonly name: string;
  /** 是否二进制编码（浏览器端需 binaryType = 'arraybuffer'） */
  readonly binary: boolean;
  encodeServer(msg: ServerMessage): string | ArrayBuffer;
  encodeClient(msg: ClientMessage): string | ArrayBuffer;
  decodeClient(raw: string | ArrayBuffer): ClientMessage;
  decodeServer(raw: string | ArrayBuffer): ServerMessage;
}

/** 默认 JSON 编解码器。够用、可读、便于抓包调试；压测阶段再换二进制。 */
export const jsonCodec: Codec = {
  name: 'json',
  binary: false,
  encodeServer: (msg) => JSON.stringify(msg),
  encodeClient: (msg) => JSON.stringify(msg),
  decodeClient: (raw) => JSON.parse(String(raw)) as ClientMessage,
  decodeServer: (raw) => JSON.parse(String(raw)) as ServerMessage,
};

/**
 * 单连接序号守卫。
 *
 * 只做一件事：判断这一帧能不能接着上一帧。
 * 不连续 → 触发 resync 回调（不要试图自己"补"行情，缺数据就是缺数据）。
 */
export class SequenceGuard {
  private last = -1;
  /** 累计检测到的缺口次数，用于上报/埋点 */
  public gapCount = 0;

  /** @returns true 表示连续；false 表示出现缺口，需要 resync */
  accept(seq: number): boolean {
    if (this.last === -1) {
      this.last = seq;
      return true;
    }
    if (seq === this.last + 1) {
      this.last = seq;
      return true;
    }
    // seq <= last：乱序/重复帧，直接丢弃
    if (seq <= this.last) return true;
    this.gapCount += 1;
    this.last = seq;
    return false;
  }

  /** 用全量快照重置基线 */
  reset(seq: number): void {
    this.last = seq;
  }

  get lastSeq(): number {
    return this.last;
  }
}
