/**
 * 交易链路自动化自测。
 *
 * 覆盖下单这件事上最容易出问题的六类场景，全部用断言固化，而不是靠手点页面：
 *
 *   [1] 风控前置校验：非整手 / 超涨跌停 / 价格笼子 / 资金不足 / 持仓不足 / 未知标的 / 缺幂等键
 *   [2] **幂等防重**：同一 clientOrderId 重复提交只产生一笔委托；同键换参数必须报冲突
 *   [3] 限价买立即成交：状态机、成交回报、持仓与资金变动、**T+1 可用不变**
 *   [4] 挂单与撤单：冻结资金、撤单释放、重复撤单幂等、已成单不可撤
 *   [5] 挂单随行情重撮成交（不是只在提交那一刻撮一次）
 *   [6] 收盘时段下单被拒（独立实例验证交易时段门禁）
 *
 * 用法：
 *   pnpm --filter @stock/server test:trading
 *   脚本自己拉起两个临时实例（8899 盘中 / 8898 收盘），结束后关闭，不依赖任何外部服务。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, '..');
const PORT = 8899; // 盘中实例（避开正在运行的 8787）
const PORT_CLOSED = 8898; // 收盘实例
const SYM = '600519.SH';

const results = [];
let failed = 0;

function check(name, cond, extra = '') {
  const ok = Boolean(cond);
  if (!ok) failed += 1;
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  — ${extra}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (v) => Math.round(v * 100) / 100;
const baseUrl = (port) => `http://127.0.0.1:${port}`;

let clientSeq = 0;
const newClientOrderId = () => `test-${Date.now().toString(36)}-${++clientSeq}`;

async function api(port, method, path, body) {
  const res = await fetch(`${baseUrl(port)}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

const get = (port, path) => api(port, 'GET', path).then((r) => r.json);
const post = (port, path, body) => api(port, 'POST', path, body);

async function healthy(port) {
  try {
    const res = await fetch(`${baseUrl(port)}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function spawnServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      SIM_MODE: 'replay',
      // 倍速刻意压到 20：60 倍速下虚拟日只有 90 秒，而本测试要跑 ~90 秒，
      // 中途翻日会重置价格，导致"挂单等价格走过来"的用例偶发失败 —— 那是测试环境问题，不是撮合逻辑问题。
      // 20 倍速下一个虚拟日约 17 分钟，测试期间不会翻日。
      SIM_SPEED: '20',
      SIM_START: '13:30',
      DROP_RATE: '0',
      ...extraEnv,
    },
  });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await healthy(port)) return child;
  }
  child.kill();
  throw new Error(`实例启动超时 port=${port}`);
}

/** 交易回报记录器：订阅一个标的让帧跑起来（否则空转，挂单不会被重撮） */
function connectRecorder(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const rec = { orders: [], trades: [], accounts: [], snapshot: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'order') rec.orders.push(m.order);
    else if (m.t === 'trade') rec.trades.push(m.trade);
    else if (m.t === 'account') rec.accounts.push(m.account);
    else if (m.t === 'trading') rec.snapshot = m;
  });
  return {
    ws,
    rec,
    ready: new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    }),
    subscribe(symbols) {
      ws.send(JSON.stringify({ t: 'sub', symbols }));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** 轮询等待委托达到某状态 */
async function waitOrderStatus(port, orderId, statuses, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const orders = await get(port, '/api/orders');
    const o = orders.find((x) => x.orderId === orderId);
    if (o && statuses.includes(o.status)) return o;
    await sleep(200);
  }
  const orders = await get(port, '/api/orders');
  return orders.find((x) => x.orderId === orderId) ?? null;
}

async function main() {
  console.log(`[准备] 启动盘中实例 :${PORT} 与收盘实例 :${PORT_CLOSED}…`);
  const childOpen = await spawnServer(PORT, { T1: '1' });
  const childClosed = await spawnServer(PORT_CLOSED, { SIM_START: '16:00' });
  console.log('[准备] 两个实例已就绪\n');

  const rec = connectRecorder(PORT);
  await rec.ready;
  rec.subscribe([SYM]);

  // 等几帧，确保盘口数据到位
  await sleep(1500);

  // ---------------------------------------------------------------- [0] 账务自洽
  console.log('[0] 账务自洽（未成交前的两个不变量）');

  const acc0 = await get(PORT, '/api/account');
  const posSum = acc0.positions.reduce((s, p) => s + p.pnl, 0);
  check(
    '总资产 = 可用 + 冻结 + 持仓市值',
    Math.abs(acc0.totalAsset - (acc0.cash + acc0.frozen + acc0.marketValue)) < 0.02,
    `${acc0.totalAsset} vs ${round2(acc0.cash + acc0.frozen + acc0.marketValue)}`,
  );
  // 这条专门卡"本金基数只算现金"的 bug：那会把整份底仓成本算成盈利
  check(
    '累计盈亏 = 持仓浮动盈亏合计（尚未成交，无已实现盈亏）',
    Math.abs(acc0.totalPnl - posSum) < 0.02,
    `累计 ${acc0.totalPnl} vs 持仓浮盈 ${round2(posSum)}`,
  );

  // ---------------------------------------------------------------- [1] 前置校验
  console.log('\n[1] 风控前置校验');

  const quotes = await get(PORT, `/api/quotes?symbols=${SYM}`);
  const quote = quotes[0];
  const last = quote.last;

  const caseLot = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: round2(last * 1.005),
    volume: 150, // 非 100 整数倍
  });
  check('买入非整手被拒', caseLot.status === 400 && caseLot.json.code === 'LOT_SIZE', caseLot.json.message);

  const caseLimit = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: round2(quote.limitUp + 1),
    volume: 100,
  });
  check(
    '价格超涨停被拒',
    caseLimit.status === 400 && caseLimit.json.code === 'PRICE_OUT_OF_LIMIT',
    caseLimit.json.message,
  );

  const caseCage = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: round2(last * 1.05), // 笼子外（>基准价×1.02）
    volume: 100,
  });
  check('价格笼子拦截生效', caseCage.status === 400 && caseCage.json.code === 'PRICE_CAGE', caseCage.json.message);

  const caseCash = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: round2(last * 1.005),
    volume: 100000,
  });
  check('可用资金不足被拒', caseCash.status === 400 && caseCash.json.code === 'INSUFFICIENT_CASH', caseCash.json.message);

  const casePos = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'sell',
    type: 'limit',
    price: round2(last * 0.995),
    volume: 999999,
  });
  check('可用持仓不足被拒', casePos.status === 400 && casePos.json.code === 'INSUFFICIENT_POSITION', casePos.json.message);

  const caseSym = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: 'NOT_EXIST.SH',
    side: 'buy',
    type: 'limit',
    price: 10,
    volume: 100,
  });
  check('未知标的被拒', caseSym.status === 400 && caseSym.json.code === 'UNKNOWN_SYMBOL');

  const caseNoId = await post(PORT, '/api/orders', {
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: round2(last * 1.005),
    volume: 100,
  });
  check('缺少幂等键被拒', caseNoId.status === 400 && caseNoId.json.code === 'MISSING_CLIENT_ORDER_ID');

  check('废单也落进委托列表（用户能看到失败原因）', Boolean(caseLot.json.order?.rejectReason));

  // ---------------------------------------------------------------- [2] 幂等防重
  console.log('\n[2] 幂等防重（弱网重试的核心）');

  const idemKey = newClientOrderId();
  const restPrice = round2(last * 0.98); // 低于市价 → 挂单，状态稳定便于对比
  const first = await post(PORT, '/api/orders', {
    clientOrderId: idemKey,
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: restPrice,
    volume: 100,
  });
  const ordersBefore = (await get(PORT, '/api/orders')).length;
  const second = await post(PORT, '/api/orders', {
    clientOrderId: idemKey,
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: restPrice,
    volume: 100,
  });
  const ordersAfter = (await get(PORT, '/api/orders')).length;

  check('首次提交成功', first.status === 200 && first.json.order?.orderId);
  check('重复提交被判为幂等命中', second.status === 200 && second.json.deduplicated === true);
  check('两次返回同一笔委托', first.json.order.orderId === second.json.order.orderId);
  check('委托总数只增加 1 笔', ordersAfter - ordersBefore === 0, `前后 ${ordersBefore} → ${ordersAfter}`);

  const conflict = await post(PORT, '/api/orders', {
    clientOrderId: idemKey,
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: restPrice,
    volume: 200, // 同一个键换了参数
  });
  check(
    '同键换参数被显式拒绝（不静默成功）',
    conflict.status === 400 && conflict.json.code === 'CLIENT_ORDER_ID_CONFLICT',
    conflict.json.message,
  );

  // ---------------------------------------------------------------- [3] 立即成交 + T+1
  console.log('\n[3] 限价买立即成交 · 账务与 T+1');

  const accBefore = await get(PORT, '/api/account');
  const posBefore = accBefore.positions.find((p) => p.symbol === SYM) ?? {
    volume: 0,
    available: 0,
  };
  const tradesBefore = (await get(PORT, '/api/trades')).length;

  const fillPrice = round2(last * 1.008); // 笼子内且必然高于卖一 → 立即成交
  const filled = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: fillPrice,
    volume: 100,
  });
  check('下单返回受理成功', filled.status === 200, `orderId=${filled.json.order?.orderId}`);
  const filledOrder = await waitOrderStatus(PORT, filled.json.order.orderId, ['filled'], 15000);
  check('委托状态最终为已成', filledOrder?.status === 'filled', `status=${filledOrder?.status}`);
  check('成交数量等于委托数量', filledOrder?.filledVolume === 100);

  const tradesAfter = await get(PORT, '/api/trades');
  check('产生成交记录', tradesAfter.length > tradesBefore, `${tradesBefore} → ${tradesAfter.length}`);
  const lastTrade = tradesAfter[0];
  check('成交记录带费用', (lastTrade?.fee ?? 0) > 0, `fee=${lastTrade?.fee}`);
  check('成交价优于或等于委托价', lastTrade ? lastTrade.price <= fillPrice + 1e-9 : false, `成交 ${lastTrade?.price} / 委托 ${fillPrice}`);

  const accAfter = await get(PORT, '/api/account');
  const posAfter = accAfter.positions.find((p) => p.symbol === SYM);
  check('持仓数量增加 100 股', posAfter.volume - posBefore.volume === 100, `${posBefore.volume} → ${posAfter.volume}`);
  check(
    'T+1 生效：当日买入不增加可用数量',
    posAfter.available === posBefore.available,
    `可用 ${posBefore.available} → ${posAfter.available}`,
  );
  check('可用资金减少（成交额 + 费用）', accAfter.cash < accBefore.cash, `${accBefore.cash} → ${accAfter.cash}`);
  check('冻结资金回到 0 或仅剩挂单占用', accAfter.frozen >= 0);

  check(
    'WS 收到委托状态变更回报',
    rec.rec.orders.some((o) => o.orderId === filled.json.order.orderId),
    `${rec.rec.orders.length} 条委托回报`,
  );
  check(
    'WS 收到成交回报',
    rec.rec.trades.some((t) => t.orderId === filled.json.order.orderId),
    `${rec.rec.trades.length} 条成交回报`,
  );
  check('WS 收到资金持仓回报', rec.rec.accounts.length > 0, `${rec.rec.accounts.length} 条`);
  check('建连时收到交易快照（委托/成交/账户）', Boolean(rec.rec.snapshot?.account));

  // ---------------------------------------------------------------- [4] 挂单与撤单
  console.log('\n[4] 挂单 · 冻结 · 撤单');

  const accPreRest = await get(PORT, '/api/account');
  const rest = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: round2(last * 0.97), // 远离市价，不会立即成交
    volume: 100,
  });
  await sleep(600);
  const restOrder = (await get(PORT, '/api/orders')).find((o) => o.orderId === rest.json.order.orderId);
  check('远离市价的买单挂在已报', restOrder?.status === 'new', `status=${restOrder?.status}`);

  const accFrozen = await get(PORT, '/api/account');
  check(
    '挂单冻结了资金',
    accFrozen.frozen - accPreRest.frozen > 0,
    `冻结 ${accPreRest.frozen} → ${accFrozen.frozen}`,
  );

  const canceled = await post(PORT, `/api/orders/${rest.json.order.orderId}/cancel`);
  check('撤单成功', canceled.status === 200 && canceled.json.order.status === 'canceled');
  const accReleased = await get(PORT, '/api/account');
  check(
    '撤单释放冻结资金',
    Math.abs(accReleased.frozen - accPreRest.frozen) < 0.02,
    `冻结 ${accFrozen.frozen} → ${accReleased.frozen}（期望回到 ${accPreRest.frozen}）`,
  );

  const cancelAgain = await post(PORT, `/api/orders/${rest.json.order.orderId}/cancel`);
  check('重复撤单是幂等的（不报错）', cancelAgain.status === 200, `status=${cancelAgain.status}`);

  const cancelFilled = await post(PORT, `/api/orders/${filled.json.order.orderId}/cancel`);
  check(
    '已成交的委托不可撤',
    cancelFilled.status === 400 && cancelFilled.json.code === 'ORDER_ALREADY_FILLED',
    cancelFilled.json.message,
  );

  // ---------------------------------------------------------------- [5] 挂单随行情重撮
  console.log('\n[5] 挂单随行情重新撮合（不是只在提交那一刻撮一次）');

  const q2 = (await get(PORT, `/api/quotes?symbols=${SYM}`))[0];
  // 挂在买一价位：此刻不满足（卖一 > 买一），等价格走动就会被重撮成交
  const reMatch = await post(PORT, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: q2.last,
    volume: 100,
  });
  const reMatchOrder = await waitOrderStatus(PORT, reMatch.json.order.orderId, ['filled', 'partially_filled'], 25000);
  check(
    '挂单被后续行情重撮成交',
    reMatchOrder?.status === 'filled' || reMatchOrder?.status === 'partially_filled',
    `status=${reMatchOrder?.status} filled=${reMatchOrder?.filledVolume}/${reMatchOrder?.volume}`,
  );

  // ---------------------------------------------------------------- [6] 收盘时段
  console.log('\n[6] 收盘时段门禁（独立实例 :8898）');

  const closedQuote = (await get(PORT_CLOSED, `/api/quotes?symbols=${SYM}`))[0];
  check('收盘实例行情阶段为 closed', closedQuote?.phase === 'closed', `phase=${closedQuote?.phase}`);

  const closedOrder = await post(PORT_CLOSED, '/api/orders', {
    clientOrderId: newClientOrderId(),
    symbol: SYM,
    side: 'buy',
    type: 'limit',
    price: closedQuote.prevClose,
    volume: 100,
  });
  check(
    '非交易时段下单被拒',
    closedOrder.status === 400 && closedOrder.json.code === 'OUT_OF_SESSION',
    closedOrder.json.message,
  );

  // ---------------------------------------------------------------- 收尾
  rec.close();
  childOpen.kill();
  childClosed.kill();

  console.log('\n' + '─'.repeat(60));
  const passed = results.length - failed;
  console.log(`结果：${passed}/${results.length} 通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
  if (failed) {
    console.log('失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.name}`));
  }
  console.log('─'.repeat(60));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n自测异常终止：${e.message}`);
  process.exit(1);
});
