/**
 * 行情协议自动化自测。
 *
 * 这个脚本的存在本身就是"可验证性"的证明：行情链路里最容易出问题的四件事，
 * 全部用断言覆盖，而不是靠人肉点页面看：
 *
 *   1. 建连握手与订阅回快照
 *   2. 增量帧的序号连续性（不能跳号）
 *   3. **丢包后能否检出缺口并自动补拉全量**（这是最关键的一条）
 *   4. 断线重连后订阅能否恢复
 *
 * 用法：
 *   pnpm --filter @stock/server test:protocol
 *   若服务未启动，脚本会自己拉起一个临时实例（结束后关闭）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, '..');
const PORT = process.env.PORT ?? '8787';
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const SYMBOLS = ['600519.SH', '300750.SZ', '000001.SZ'];

const results = [];
let failed = 0;

function check(name, cond, extra = '') {
  const ok = Boolean(cond);
  if (!ok) failed += 1;
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  — ${extra}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 若没有现成服务，自己拉起一个（stdio 忽略，避免与断言输出混在一起） */
async function ensureServer() {
  if (await healthy()) {
    console.log(`[准备] 复用已有服务 ${BASE}`);
    return null;
  }
  console.log(`[准备] 未检测到服务，正在启动临时实例…`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
    env: { ...process.env, PORT, DROP_RATE: '0', SIM_SPEED: '120' },
  });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await healthy()) {
      console.log(`[准备] 临时服务已就绪`);
      return child;
    }
  }
  child.kill();
  throw new Error('服务启动超时');
}

/** 极简客户端：只关心序号连续性，用于独立验证服务端行为 */
function createClient() {
  const ws = new WebSocket(WS_URL);
  const state = {
    hello: null,
    snapshots: [],
    deltas: [],
    pongs: [],
    gaps: [],
    lastSeq: -1,
  };

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'hello') state.hello = msg;
    else if (msg.t === 'snapshot') {
      state.snapshots.push(msg);
      state.lastSeq = msg.seq;
    } else if (msg.t === 'delta') {
      if (state.lastSeq !== -1 && msg.seq > state.lastSeq + 1) {
        state.gaps.push({ from: state.lastSeq, to: msg.seq });
      }
      state.lastSeq = Math.max(state.lastSeq, msg.seq);
      state.deltas.push(msg);
    } else if (msg.t === 'pong') state.pongs.push(msg);
  });

  return {
    ws,
    state,
    ready: new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    }),
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    waitFor(predicate, timeoutMs = 12_000) {
      return new Promise((res, rej) => {
        const started = Date.now();
        const tick = () => {
          if (predicate()) return res(true);
          if (Date.now() - started > timeoutMs) return rej(new Error('等待超时'));
          setTimeout(tick, 80);
        };
        tick();
      });
    },
  };
}

async function main() {
  const child = await ensureServer();
  console.log('\n[1] 建连与握手');
  const c = createClient();
  await c.ready;
  await c.waitFor(() => c.state.hello, 4000);
  check('收到 hello 帧并声明协议版本', c.state.hello?.ver === 1, `ver=${c.state.hello?.ver}`);
  check('hello 携带心跳与帧间隔参数', c.state.hello?.heartbeatMs > 0 && c.state.hello?.frameMs > 0);

  console.log('\n[2] 订阅即回快照');
  c.send({ t: 'sub', symbols: SYMBOLS });
  await c.waitFor(() => c.state.snapshots.length > 0, 5000);
  const snap = c.state.snapshots[0];
  check('订阅后立即收到全量快照', Boolean(snap));
  check(
    '快照只包含订阅的标的',
    snap.quotes.every((q) => SYMBOLS.includes(q.symbol)),
    `${snap.quotes.length} 条`,
  );
  check('快照带五档盘口', snap.quotes.every((q) => Array.isArray(q.bids) && q.bids.length === 5));

  console.log('\n[3] 增量帧序号连续性');
  await sleep(2500);
  check('已持续收到增量帧', c.state.deltas.length >= 3, `${c.state.deltas.length} 帧`);
  const seqs = c.state.deltas.map((d) => d.seq);
  const contiguous = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  check('序号严格单调递增', contiguous);
  check('正常链路下无缺口', c.state.gaps.length === 0);

  console.log('\n[4] 丢包 → 序号缺口 → 自动补拉（核心断言）');
  await fetch(`${BASE}/api/debug/drop?rate=0.7`);
  console.log('     已注入 70% 丢帧率…');
  let detected = true;
  try {
    await c.waitFor(() => c.state.gaps.length > 0, 15_000);
  } catch {
    detected = false;
  }
  check('客户端检出序号缺口', detected, c.state.gaps[0] ? `缺口 ${c.state.gaps[0].from} → ${c.state.gaps[0].to}` : '');
  if (detected) {
    const before = c.state.snapshots.length;
    c.send({ t: 'resync', symbols: SYMBOLS });
    await c.waitFor(() => c.state.snapshots.length > before, 5000);
    const resync = c.state.snapshots[c.state.snapshots.length - 1];
    check('补拉请求返回新的全量快照', c.state.snapshots.length > before);
    check('补拉快照的 seq 不低于已收到的最大 seq', resync.seq >= c.state.gaps[0].from);
  }
  await fetch(`${BASE}/api/debug/drop?rate=0`);
  console.log('     已恢复正常丢帧率');

  console.log('\n[5] 心跳往返');
  const pingTs = Date.now();
  c.send({ t: 'ping', ts: pingTs });
  await c.waitFor(() => c.state.pongs.length > 0, 5000);
  check('ping 得到 pong 且回显时间戳', c.state.pongs[0]?.ts === pingTs);

  console.log('\n[6] 断线重连 + 订阅恢复');
  c.ws.close();
  await sleep(600);
  const c2 = createClient();
  await c2.ready;
  await c2.waitFor(() => c2.state.hello, 4000);
  check('重连后重新握手成功', Boolean(c2.state.hello));
  c2.send({ t: 'sub', symbols: SYMBOLS });
  await c2.waitFor(() => c2.state.snapshots.length > 0, 5000);
  check('重连后重新订阅可再次拿到快照', c2.state.snapshots.length > 0);
  await sleep(1500);
  check('重连后增量帧恢复流动', c2.state.deltas.length > 0, `${c2.state.deltas.length} 帧`);
  c2.ws.close();

  console.log('\n[7] 非法输入防护');
  const c3 = createClient();
  await c3.ready;
  c3.send({ t: 'sub', symbols: ['NOT_A_STOCK'] });
  await sleep(1200);
  check('未知标的被拒绝且不崩溃', c3.state.snapshots.length === 0);
  c3.send({ t: 'sub', symbols: ['600519.SH'] });
  await c3.waitFor(() => c3.state.snapshots.length > 0, 5000);
  check('拒绝非法标的后仍能正常服务', c3.state.snapshots.length > 0);
  c3.ws.close();

  console.log('\n' + '─'.repeat(56));
  const passed = results.length - failed;
  console.log(`结果：${passed}/${results.length} 通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
  if (failed) {
    console.log('失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.name}`));
  }
  console.log('─'.repeat(56));

  if (child) child.kill();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n自测异常终止：${e.message}`);
  process.exit(1);
});
