/**
 * BFF / 行情网关服务。
 *
 * 职责边界（这是"大前端"里很关键的一层）：
 *   - 浏览器不能直连行情源（CORS + Referer 校验），所以必须由服务端代理；
 *   - 行情源随时可能降级，降级逻辑收在服务端，前端只面对一种稳定的数据契约；
 *   - 离线包/H5 的静态资源由 Vite 或 CDN 承担，这里只提供数据面。
 *
 * 启动参数（全部走环境变量，方便一键切换演示形态）：
 *   PORT=8787            监听端口
 *   SIM_MODE=replay      replay 虚拟时间 / live 真实时间
 *   SIM_SPEED=60         倍速（1 真实秒 = N 虚拟秒）
 *   SIM_START=13:30      虚拟起始时刻，设为 10:30 就能一进来看到半天分时图
 *   FRAME_MS=500         推帧间隔
 *   DROP_RATE=0          人为丢帧概率（演示序号缺口补拉用）
 *   QUOTE_SOURCE=mock    mock / eastmoney
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionMinuteIndex } from '@stock/market-core';
import type { OrderDraft, Period } from '@stock/market-core';
import { SimClock } from './clock';
import type { ClockMode } from './clock';
import { KlineStore } from './kline';
import { MarketGateway } from './gateway';
import { TradingService } from './trading';
import { MockQuoteSource, createSource } from './sources';
import { DEFAULT_WATCHLIST, INSTRUMENTS, INSTRUMENT_MAP } from './instruments';

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** '13:30' → 48600（当日秒数） */
function parseClock(s: string | undefined, fallback: number): number {
  if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return fallback;
  const [h, m] = s.split(':').map(Number);
  return h * 3600 + m * 60;
}

const PORT = num(process.env.PORT, 8787);
const SIM_MODE = (process.env.SIM_MODE as ClockMode) ?? 'replay';
const SIM_SPEED = num(process.env.SIM_SPEED, 60);
const SIM_START = parseClock(process.env.SIM_START, 13 * 3600 + 30 * 60);
const FRAME_MS = num(process.env.FRAME_MS, 500);
const DROP_RATE = num(process.env.DROP_RATE, 0);
const VALID_PERIODS: Period[] = ['1m', '5m', '15m', '30m', '60m', '1d'];

// ------------------------------------------------------------------ 组装

const clock = new SimClock(SIM_MODE, SIM_SPEED, SIM_START);
const source = createSource();
const kline = new KlineStore();

/**
 * 播种当日分时 + 回填当日累计量额。
 *
 * 两个关键点：
 *  1. 服务启动时执行一次 → 一打开页面就有完整分时图，而不是从空图开始长；
 *  2. 虚拟翻日时再执行一次（见下面的 onRollover）→ 翻日之后图表立刻是满的。
 * prevClose 从行情源实时取，而不是读主数据里的静态值 —— 翻日后昨收会变。
 */
function reseedSession(): void {
  if (!(source instanceof MockQuoteSource)) return;
  const elapsed = sessionMinuteIndex(clock.now()) + 1;
  if (elapsed <= 0) return;
  for (const inst of INSTRUMENTS) {
    const st = source.getState(inst.symbol);
    if (!st) continue;
    const bars = kline.seedSession(inst.symbol, st.prevClose, st.last, elapsed, clock.now());
    if (bars.length === 0) continue;
    // 让快照里的 开/高/低/量/额 与分时图完全自洽
    source.seedDailyState(inst.symbol, {
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      volume: bars.reduce((s, b) => s + b.volume, 0),
      amount: bars.reduce((s, b) => s + b.amount, 0),
    });
  }
}

const gateway = new MarketGateway(source, clock, kline, {
  frameMs: FRAME_MS,
  dropRate: DROP_RATE,
  onRollover: reseedSession,
});

/**
 * 交易服务。
 * 回报推给网关 → 网关广播给所有连接；交易服务自身不关心连接，只关心账务。
 * 这里用 setter 注入而不用构造参数，是为了打破 gateway ↔ trading 的循环依赖。
 */
const trading = new TradingService({
  onOrder: (order) => gateway.pushTrading({ t: 'order', order }),
  onTrade: (trade) => gateway.pushTrading({ t: 'trade', trade }),
  onAccount: (account) => gateway.pushTrading({ t: 'account', account }),
});
gateway.setTrading(trading);

source.bootstrap();
reseedSession();

// 把初始行情灌给交易服务。
// 收盘后没有帧在跑（无订阅即空转），但下单校验仍需要行情才能判断"是否交易时段" ——
// 不灌的话收盘时下单会错报"暂无行情"，而不是"非交易时段"。
trading.onQuotes(source.snapshot(INSTRUMENTS.map((i) => i.symbol), clock.phase()));
const seeded = sessionMinuteIndex(clock.now()) + 1;
if (seeded > 0) {
  console.log(`[K线] 已播种当日分时 ${seeded} 分钟 × ${INSTRUMENTS.length} 标的`);
}

// ------------------------------------------------------------------ HTTP

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  setCors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // 交易类接口都是 POST，交给独立的路由函数处理（需要读请求体）
  if (req.method === 'POST') {
    void handlePost(req, res, url);
    return;
  }

  switch (path) {
    case '/':
      json(res, {
        name: 'stock-market-h5 BFF',
        ws: `ws://localhost:${PORT}/ws`,
        endpoints: [
          '/api/instruments',
          '/api/watchlist',
          '/api/quotes',
          '/api/kline',
          '/api/account',
          '/api/orders',
          '/api/trades',
          '/api/trading/limits',
          '/api/stats',
        ],
        post: ['/api/orders', '/api/orders/:orderId/cancel'],
      });
      return;

    case '/api/health':
      json(res, { ok: true, uptimeMs: clock.uptimeMs });
      return;

    case '/api/instruments':
      json(res, INSTRUMENTS);
      return;

    case '/api/watchlist':
      json(res, DEFAULT_WATCHLIST);
      return;

    case '/api/quotes': {
      const symbols = (url.searchParams.get('symbols') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => INSTRUMENT_MAP.has(s));
      const list = symbols.length ? symbols : DEFAULT_WATCHLIST;
      json(res, source.snapshot(list, clock.phase()));
      return;
    }

    case '/api/kline': {
      const symbol = url.searchParams.get('symbol') ?? '';
      const period = (url.searchParams.get('period') ?? '1d') as Period;
      if (!INSTRUMENT_MAP.has(symbol)) {
        json(res, { error: `未知标的: ${symbol}` }, 400);
        return;
      }
      if (!VALID_PERIODS.includes(period)) {
        json(res, { error: `不支持的周期: ${period}` }, 400);
        return;
      }
      const limit = Math.min(num(url.searchParams.get('limit') ?? undefined, 240), 500);
      json(res, {
        symbol,
        period,
        bars: kline.get(symbol, period, limit),
      });
      return;
    }

    case '/api/stats':
      json(res, gateway.stats);
      return;

    // ---------------------------------------------------------------- 交易查询
    case '/api/account':
      json(res, trading.getAccount());
      return;

    case '/api/orders':
      json(res, trading.getOrders());
      return;

    case '/api/trades':
      json(res, trading.getTrades());
      return;

    /**
     * 一键最大可买/可卖。
     * 刻意放在服务端算：整手规则、预留手续费这些口径如果前端各算一遍，
     * 迟早出现"前端说能买 100 股、后端说资金不足"的错位。
     */
    case '/api/trading/limits': {
      const symbol = url.searchParams.get('symbol') ?? '';
      json(res, {
        symbol,
        maxBuy: trading.maxBuyVolume(symbol),
        maxSell: trading.maxSellVolume(symbol),
      });
      return;
    }

    /**
     * 演示用：运行期调整丢帧概率。
     * 浏览器控制台执行 `fetch('/api/debug/drop?rate=0.4')` 就能当场看到
     * 前端状态条切到"序号缺口补拉中"，然后自动恢复。
     */
    case '/api/debug/drop': {
      const rate = Math.min(Math.max(num(url.searchParams.get('rate') ?? undefined, 0), 0), 1);
      gateway.dropRate = rate;
      json(res, { ok: true, dropRate: gateway.dropRate });
      return;
    }

    default:
      json(res, { error: 'Not Found' }, 404);
  }
}

// ------------------------------------------------------------------ 交易（POST）

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new Error('请求体过大');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const path = url.pathname;
  try {
    // ---- 下单
    if (path === '/api/orders') {
      const body = await readJsonBody(req);
      const clientOrderId = String(body.clientOrderId ?? '');
      if (!clientOrderId) {
        json(res, { code: 'MISSING_CLIENT_ORDER_ID', message: '缺少客户端订单号（幂等键）' }, 400);
        return;
      }
      const symbol = String(body.symbol ?? '');
      if (!INSTRUMENT_MAP.has(symbol)) {
        json(res, { code: 'UNKNOWN_SYMBOL', message: `未知标的 ${symbol}` }, 400);
        return;
      }
      const draft: OrderDraft & { clientOrderId: string } = {
        clientOrderId,
        symbol,
        side: body.side === 'sell' ? 'sell' : 'buy',
        type: body.type === 'market-opponent' ? 'market-opponent' : 'limit',
        price: Number(body.price ?? 0),
        volume: Math.floor(Number(body.volume ?? 0)),
      };
      const result = trading.submitOrder(draft, clock.now());
      if (!result.ok) {
        // 400 + 结构化 code：前端据此做精确提示，而不是弹一句"下单失败"
        json(res, { code: result.code, message: result.message, order: result.order }, 400);
        return;
      }
      json(res, { order: result.order, deduplicated: result.deduplicated });
      return;
    }

    // ---- 撤单
    const cancelMatch = /^\/api\/orders\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch) {
      const result = trading.cancelOrder(decodeURIComponent(cancelMatch[1]), clock.now());
      if (!result.ok) {
        json(res, { code: result.code, message: result.message }, 400);
        return;
      }
      json(res, { order: result.order, deduplicated: result.deduplicated });
      return;
    }

    json(res, { error: 'Not Found' }, 404);
  } catch (e) {
    json(res, { code: 'BAD_REQUEST', message: String(e) }, 400);
  }
}

const server = createServer(handle);
gateway.attach(server);
gateway.start();

server.listen(PORT, () => {
  const info = gateway.stats;
  console.log('');
  console.log('  ┌───────────────────────────────────────────────┐');
  console.log('  │  A股行情 BFF 已启动                            │');
  console.log('  └───────────────────────────────────────────────┘');
  console.log(`   HTTP      http://localhost:${PORT}`);
  console.log(`   WebSocket ws://localhost:${PORT}/ws`);
  console.log(`   行情源    ${info.source}${info.degraded ? '（已降级）' : ''}`);
  console.log(`   时钟      ${info.clock.mode}  倍速 ${info.clock.speed}x`);
  console.log(`   虚拟时间  ${info.clock.virtualTime}  (${info.clock.phase})`);
  console.log(`   标的数    ${info.instruments}`);
  console.log(`   推帧      ${info.frameMs}ms   丢帧概率 ${info.dropRate}`);
  console.log(`   交易      T+1 ${(process.env.T1 ?? '1') !== '0' ? '开启' : '关闭'}   初始资金 ${trading.getAccount().cash.toFixed(0)} 元`);
  console.log('');
});

function shutdown(): void {
  console.log('\n[服务] 正在关闭…');
  gateway.stop();
  source.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
