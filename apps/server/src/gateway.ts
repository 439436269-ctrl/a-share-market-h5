/**
 * 行情网关（WS 服务端）。
 *
 * 帧模型：每 FRAME_MS 推进一次行情源，产出一帧增量，广播给所有连接。
 *
 * 三个刻意的设计决策，都是面试会被追问的点：
 *
 * 1. **单次序列化，多连接复用**：同一帧对所有客户端内容一致，
 *    所以 JSON.stringify 只做一次。若按连接逐个序列化，
 *    CPU 会随连接数线性上升 —— 这是行情网关最典型的性能陷阱。
 *
 * 2. **全局单调 seq + 丢帧注入**：seq 每帧自增，无论这一帧有没有真的发出去。
 *    人为丢帧（dropRate）会让客户端看到序号跳变，从而触发 resync。
 *    这是**可演示的可靠性机制**，不是纸面设计。
 *
 * 3. **无订阅就不空转**：没有任何客户端订阅时直接跳过这一帧，
 *    不推进行情源、不构造数据。真实网关也是按订阅集合裁剪数据流的。
 */
import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import {
  FRAME_MS,
  PROTOCOL_VERSION,
  HEARTBEAT_MS,
  jsonCodec,
  sessionMinuteIndex,
} from '@stock/market-core';
import type { ClientMessage, MarketPhase, Quote } from '@stock/market-core';
import type { QuoteSource } from './sources';
import type { SimClock } from './clock';
import type { KlineStore } from './kline';
import { INSTRUMENT_MAP, INSTRUMENTS } from './instruments';

interface ClientState {
  symbols: Set<string>;
}

export interface GatewayOptions {
  frameMs?: number;
  /** 人为丢帧概率 0~1，默认 0 */
  dropRate?: number;
  /**
   * 虚拟交易日翻页后的回调。
   * 调用方应在此把当日分时重新播种 —— 否则翻日之后分时图会是空的，
   * 演示时看起来就像"数据挂了"。
   */
  onRollover?: () => void;
}

export class MarketGateway {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Map<WebSocket, ClientState>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 全局帧序号：只要产生了一帧就自增，与是否成功发送无关 */
  private seq = 0;
  private lastVirtualNow = 0;
  private sentFrames = 0;
  private droppedFrames = 0;

  constructor(
    private readonly source: QuoteSource,
    private readonly clock: SimClock,
    private readonly kline: KlineStore,
    private readonly options: GatewayOptions = {},
  ) {}

  private get frameMs(): number {
    return this.options.frameMs ?? FRAME_MS;
  }

  /** 运行期可调 —— 用于现场演示"丢包 → 自动补拉" */
  dropRate = 0;

  attach(server: Server): void {
    const wss = new WebSocketServer({ server, path: '/ws' });
    this.wss = wss;

    wss.on('connection', (ws) => {
      this.clients.set(ws, { symbols: new Set() });
      this.send(ws, {
        t: 'hello',
        ver: PROTOCOL_VERSION,
        serverTs: Date.now(),
        heartbeatMs: HEARTBEAT_MS,
        frameMs: this.frameMs,
      });

      ws.on('message', (raw) => this.onMessage(ws, raw.toString()));
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  start(): void {
    if (this.timer) return;
    this.dropRate = this.options.dropRate ?? 0;
    this.timer = setInterval(() => this.frame(), this.frameMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wss?.close();
    this.wss = null;
    for (const ws of this.clients.keys()) ws.close(1001, 'server shutdown');
    this.clients.clear();
  }

  // ------------------------------------------------------------------ 单帧

  private frame(): void {
    // 无人订阅：不推进、不构造、不序列化 —— 省掉整个数据链路
    const active = new Set<string>();
    for (const c of this.clients.values()) for (const s of c.symbols) active.add(s);
    if (active.size === 0) return;

    // 虚拟交易日翻页（replay 模式走到 15:00 后）
    if (this.clock.tickRollover()) {
      this.kline.commitDay(); // 当日分时 → 一根日线，归档
      this.source.resetDay(); // 昨收 = 上一交易日收盘
      this.kline.resetSession(); // 清空当日分时
      this.options.onRollover?.(); // 重新播种，保证图表立刻是满的
      this.lastVirtualNow = 0;
      console.log(
        `[网关] 进入新的虚拟交易日 #${this.clock.day}（${this.clock.describe().virtualTime}）`,
      );
    }

    const now = this.clock.now();
    const phase: MarketPhase = this.clock.phase();
    // 波动率按虚拟时间的真实步长缩放，改倍速不会失真
    let dtSeconds = this.lastVirtualNow ? (now - this.lastVirtualNow) / 1000 : this.frameMs / 1000;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || dtSeconds > 3600) {
      dtSeconds = this.frameMs / 1000;
    }
    this.lastVirtualNow = now;

    const { quotes, ticks } = this.source.step({ now, dtSeconds, phase, symbols: active });
    if (quotes.length === 0 && ticks.length === 0) return; // 无变化不发帧，序号也不动

    // 逐笔归并进 1 分钟 bar
    for (const t of ticks) this.kline.appendTick(t.symbol, t.price, t.volume, now);

    this.seq += 1;

    // 丢帧注入：seq 已经自增但这一帧不发 → 客户端下一帧必然看到序号缺口
    if (this.dropRate > 0 && Math.random() < this.dropRate) {
      this.droppedFrames += 1;
      return;
    }

    // 只序列化一次，复用给所有连接
    const payload = jsonCodec.encodeServer({ t: 'delta', seq: this.seq, quotes, ticks });
    this.sentFrames += 1;
    for (const ws of this.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // ------------------------------------------------------------------ 收消息

  private onMessage(ws: WebSocket, raw: string): void {
    const state = this.clients.get(ws);
    if (!state) return;

    let msg: ClientMessage;
    try {
      msg = jsonCodec.decodeClient(raw);
    } catch {
      this.send(ws, { t: 'error', code: 'BAD_MESSAGE', message: '无法解析的消息' });
      return;
    }

    switch (msg.t) {
      case 'sub': {
        const accepted: string[] = [];
        for (const s of msg.symbols) {
          if (!INSTRUMENT_MAP.has(s)) continue; // 未知标的直接拒绝，不静默接受
          state.symbols.add(s);
          accepted.push(s);
        }
        // 订阅即回快照：让 UI 立刻有数，而不是等下一帧
        if (accepted.length) this.sendSnapshot(ws, accepted);
        break;
      }

      case 'unsub':
        for (const s of msg.symbols) state.symbols.delete(s);
        break;

      case 'resync':
        this.sendSnapshot(ws, msg.symbols.length ? msg.symbols : [...state.symbols]);
        break;

      case 'ping':
        this.send(ws, { t: 'pong', ts: msg.ts, serverTs: Date.now() });
        break;
    }
  }

  /** 全量快照：seq 取当前帧序号，客户端以此重置序号基线 */
  private sendSnapshot(ws: WebSocket, symbols: string[]): void {
    const phase = this.clock.phase();
    const quotes: Quote[] = this.source.snapshot(symbols, phase);
    this.send(ws, { t: 'snapshot', seq: this.seq, quotes });
  }

  private send(ws: WebSocket, msg: Parameters<typeof jsonCodec.encodeServer>[0]): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(jsonCodec.encodeServer(msg));
  }

  // ------------------------------------------------------------------ 观测

  get stats() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      clients: this.clients.size,
      subscriptions: [...this.clients.values()].reduce((n, c) => n + c.symbols.size, 0),
      seq: this.seq,
      sentFrames: this.sentFrames,
      droppedFrames: this.droppedFrames,
      dropRate: this.dropRate,
      frameMs: this.frameMs,
      source: this.source.name,
      degraded: this.source.degraded,
      clock: this.clock.describe(),
      sessionMinute: sessionMinuteIndex(this.clock.now()),
      instruments: INSTRUMENTS.length,
    };
  }
}
