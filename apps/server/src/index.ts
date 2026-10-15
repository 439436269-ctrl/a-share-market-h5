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
import type { Period } from '@stock/market-core';
import { SimClock } from './clock';
import type { ClockMode } from './clock';
import { KlineStore } from './kline';
import { MarketGateway } from './gateway';
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

source.bootstrap();
reseedSession();
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

  switch (path) {
    case '/':
      json(res, {
        name: 'stock-market-h5 BFF',
        ws: `ws://localhost:${PORT}/ws`,
        endpoints: ['/api/instruments', '/api/watchlist', '/api/quotes', '/api/kline', '/api/stats'],
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
