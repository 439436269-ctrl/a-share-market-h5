/**
 * 行情长连接客户端。
 *
 * 这个类只解决一个问题：**让上层永远看到一份"连续且不落后"的行情**。
 * 拆开是四件事，每件都有明确的失败场景：
 *
 *   1. 心跳探活   —— TCP 连接可能"假活"（对端进程死了但没发 FIN），
 *                    只靠 onclose 会一直挂着不重连，必须靠 pong 超时兜底。
 *   2. 退避重连   —— 固定间隔重连会在服务端重启时形成"重连风暴"，
 *                    必须指数退避 + 抖动（jitter）打散。
 *   3. 订阅恢复   —— 新连接是干净状态，必须把订阅集合重放一遍，
 *                    否则重连成功但页面一片空白。
 *   4. 缺口补拉   —— 广播帧丢一帧，盘口就永久错下去。
 *                    靠 seq 检测缺口 → 主动拉全量快照，而不是"猜"。
 */
import {
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  FRAME_MS,
  SequenceGuard,
  jsonCodec,
} from '@stock/market-core';
import type {
  Account,
  ClientMessage,
  Codec,
  ConnectionStatus,
  Order,
  Quote,
  ServerMessage,
  Tick,
  Trade,
} from '@stock/market-core';

/** WebSocket 的最小接口约束 —— 浏览器用原生实现，Node 端注入 `ws`，便于自动化测试 */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface GapInfo {
  lastSeq: number;
  gotSeq: number;
  /** 缺失帧数 */
  missed: number;
}

export interface MarketStats {
  status: ConnectionStatus;
  /** 累计检测到的序号缺口次数 */
  gaps: number;
  /** 累计重连次数 */
  reconnects: number;
  lastSeq: number;
  subscribed: number;
  /** 最近一次心跳往返延迟（ms） */
  rtt: number;
  /** 从建连到当前收到的帧数 */
  frames: number;
}

export interface MarketConnectionOptions {
  url: string;
  codec?: Codec;
  WebSocketImpl?: new (url: string) => WebSocketLike;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  maxBackoffMs?: number;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onQuotes?: (quotes: Quote[]) => void;
  onTicks?: (ticks: Tick[]) => void;
  onGap?: (info: GapInfo) => void;
  onStats?: (stats: MarketStats) => void;
  log?: (msg: string) => void;
  // ---- 交易私有回报（不参与行情帧的 seq 机制，见 protocol.ts 的说明）
  /** 建连后的交易快照：委托 / 成交 / 资金持仓 */
  onTradingSnapshot?: (snapshot: { orders: Order[]; trades: Trade[]; account: Account }) => void;
  onOrder?: (order: Order) => void;
  onTrade?: (trade: Trade) => void;
  onAccount?: (account: Account) => void;
}

export class MarketConnection {
  private readonly opts: Required<
    Pick<MarketConnectionOptions, 'url' | 'codec' | 'heartbeatMs' | 'heartbeatTimeoutMs' | 'maxBackoffMs'>
  > &
    MarketConnectionOptions;

  private ws: WebSocketLike | null = null;
  /** 订阅集合 —— 它必须活过重连，这是"订阅恢复"的唯一真相来源 */
  private readonly subscriptions = new Set<string>();
  private readonly guard = new SequenceGuard();

  private status: ConnectionStatus = 'idle';
  private attempts = 0;
  private reconnects = 0;
  private frames = 0;
  private rtt = 0;
  private lastPongAt = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastResyncAt = 0;
  /** 主动关闭标记 —— 区分"我们要关"和"链路断了" */
  private closing = false;

  constructor(options: MarketConnectionOptions) {
    this.opts = {
      codec: jsonCodec,
      heartbeatMs: HEARTBEAT_MS,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      maxBackoffMs: 30_000,
      ...options,
    };
  }

  // ------------------------------------------------------------------ 生命周期

  connect(): void {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.closing = false;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');

    const Impl =
      this.opts.WebSocketImpl ??
      (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike);
    if (!Impl) throw new Error('没有可用的 WebSocket 实现，请通过 WebSocketImpl 注入');

    const ws = new Impl(this.opts.url);
    if (this.opts.codec.binary) {
      // 仅在二进制协议下设置；不同实现的合法取值不同，失败不应影响建连
      try {
        ws.binaryType = 'arraybuffer';
      } catch {
        /* ignore */
      }
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastPongAt = Date.now();
      this.setStatus('open');
      // 订阅恢复：新连接必须重放订阅集合
      this.send({ t: 'sub', symbols: [...this.subscriptions] });
      // 并要求一份全量快照作为 seq 基线
      this.send({ t: 'resync', symbols: [...this.subscriptions] });
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => this.handleMessage(ev.data);

    ws.onerror = () => {
      this.log('websocket error');
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      if (this.closing) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  close(): void {
    this.closing = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.ws?.close(1000, 'client close');
    this.ws = null;
    this.setStatus('closed');
  }

  // ------------------------------------------------------------------ 订阅

  subscribe(symbols: string[]): void {
    const added = symbols.filter((s) => !this.subscriptions.has(s));
    added.forEach((s) => this.subscriptions.add(s));
    if (added.length === 0) return;
    if (this.isOpen()) this.send({ t: 'sub', symbols: added });
    this.emitStats();
  }

  unsubscribe(symbols: string[]): void {
    const removed = symbols.filter((s) => this.subscriptions.has(s));
    removed.forEach((s) => this.subscriptions.delete(s));
    if (removed.length === 0) return;
    if (this.isOpen()) this.send({ t: 'unsub', symbols: removed });
    this.emitStats();
  }

  /** 手动补拉全量（节流，避免缺口风暴时打爆服务端） */
  resync(reason = 'manual'): void {
    const now = Date.now();
    if (now - this.lastResyncAt < 1000) return;
    this.lastResyncAt = now;
    this.log(`resync: ${reason}`);
    this.send({ t: 'resync', symbols: [...this.subscriptions] });
  }

  // ------------------------------------------------------------------ 收帧

  private handleMessage(data: unknown): void {
    let msg: ServerMessage;
    try {
      msg = this.opts.codec.decodeServer(data as string | ArrayBuffer);
    } catch {
      this.log('协议解析失败，丢弃该帧');
      return;
    }

    switch (msg.t) {
      case 'hello':
        this.log(`协议 v${msg.ver}，帧间隔 ${msg.frameMs}ms`);
        break;

      case 'pong':
        this.lastPongAt = Date.now();
        this.rtt = this.lastPongAt - msg.ts;
        this.emitStats();
        break;

      // ---- 交易私有回报：不走序号守卫，直接上抛（丢一条就是状态错，语义与行情不同）
      case 'trading':
        this.opts.onTradingSnapshot?.({
          orders: msg.orders,
          trades: msg.trades,
          account: msg.account,
        });
        break;

      case 'order':
        this.opts.onOrder?.(msg.order);
        break;

      case 'trade':
        this.opts.onTrade?.(msg.trade);
        break;

      case 'account':
        this.opts.onAccount?.(msg.account);
        break;

      case 'snapshot': {
        // 全量快照 = 新的序号基线
        this.guard.reset(msg.seq);
        const mine = this.filterQuotes(msg.quotes);
        if (mine.length) this.opts.onQuotes?.(mine);
        this.frames++;
        if (this.status === 'resyncing') this.setStatus('open', '快照已补齐');
        this.emitStats();
        break;
      }

      case 'delta': {
        // 注意：accept() 会推进内部序号，缺口信息必须在调用前取
        const prevSeq = this.guard.lastSeq;
        const ok = this.guard.accept(msg.seq);
        if (!ok) {
          // 缺口：告诉上层，并立刻拉全量。不"猜"丢失的那一帧。
          this.opts.onGap?.({
            lastSeq: prevSeq,
            gotSeq: msg.seq,
            missed: Math.max(0, msg.seq - prevSeq - 1),
          });
          this.setStatus('resyncing', `序号缺口 @${msg.seq}`);
          this.resync(`gap@${msg.seq}`);
          break;
        }
        this.frames++;
        const quotes = this.filterQuotes(msg.quotes);
        if (quotes.length) this.opts.onQuotes?.(quotes);
        const ticks = msg.ticks.filter((t) => this.subscriptions.has(t.symbol));
        if (ticks.length) this.opts.onTicks?.(ticks);
        this.emitStats();
        break;
      }

      case 'error':
        this.log(`服务端错误 ${msg.code}: ${msg.message}`);
        break;
    }
  }

  /** 只把订阅到的标的上抛 —— 服务端是广播式，本地过滤是客户端的职责 */
  private filterQuotes(quotes: Quote[]): Quote[] {
    if (this.subscriptions.size === 0) return [];
    return quotes.filter((q) => this.subscriptions.has(q.symbol));
  }

  // ------------------------------------------------------------------ 心跳

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 先探活：超过阈值没收到 pong，说明链路已死 → 强制重连
      if (Date.now() - this.lastPongAt > this.opts.heartbeatTimeoutMs) {
        this.log('心跳超时，强制重连');
        this.forceReconnect();
        return;
      }
      this.send({ t: 'ping', ts: Date.now() });
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ------------------------------------------------------------------ 重连

  private forceReconnect(): void {
    this.stopHeartbeat();
    try {
      this.ws?.close(4000, 'heartbeat timeout');
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (!this.closing) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.attempts++;
    this.reconnects++;
    // 指数退避 + 全抖动：避免所有客户端在同一毫秒一起回来
    const base = Math.min(this.opts.maxBackoffMs, 500 * 2 ** (this.attempts - 1));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.setStatus('reconnecting', `${(delay / 1000).toFixed(1)}s 后第 ${this.attempts} 次重连`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // ------------------------------------------------------------------ 工具

  private isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  private send(msg: ClientMessage): void {
    if (!this.isOpen()) return; // 未连上时静默丢弃：订阅集合已记录，重连时会重放
    try {
      this.ws!.send(this.opts.codec.encodeClient(msg));
    } catch (e) {
      this.log(`发送失败: ${String(e)}`);
    }
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status;
    this.opts.onStatus?.(status, detail);
    this.emitStats();
  }

  private emitStats(): void {
    this.opts.onStats?.(this.stats);
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  get stats(): MarketStats {
    return {
      status: this.status,
      gaps: this.guard.gapCount,
      reconnects: this.reconnects,
      lastSeq: this.guard.lastSeq,
      subscribed: this.subscriptions.size,
      rtt: this.rtt,
      frames: this.frames,
    };
  }

  get subscribedSymbols(): string[] {
    return [...this.subscriptions];
  }
}

export { FRAME_MS };
