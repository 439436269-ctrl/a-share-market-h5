/**
 * 交易链路的前端渲染核验（配合 tools/visual-check.mjs --eval-file 使用）。
 *
 * 不只截个图看"有没有渲染"，而是逐条断言：
 *   - 下单弹层的预填、快捷按钮、**共享校验函数的即时提示**（超价格笼子应立刻报 102%）
 *   - 二次确认页是否带全关键参数与 T+1 风险提示
 *   - 幂等：同一 clientOrderId 重复提交必须被判为命中、返回同一笔委托
 *   - 交易页是否实时反映了委托 / 成交 / 持仓变动
 *
 * 受控输入用原生 setter + input 事件写入 —— React 监听的是自己的合成事件，
 * 直接改 el.value 不会触发 onChange（这是驱动 React 表单最容易踩的坑）。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  const step = (name, ok, extra) => out.steps.push({ name, ok: Boolean(ok), extra: extra ?? '' });

  const setNativeInput = (el, value) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // ---- 0. 进个股详情页
  location.hash = '#/stock/600519.SH';
  await sleep(2600);

  // ---- 1. 打开下单弹层
  const buyBtn = [...document.querySelectorAll('.trade-actions .btn')].find(
    (b) => b.textContent.trim() === '买入',
  );
  step('详情页存在「买入」按钮', buyBtn);
  if (!buyBtn) return JSON.stringify(out, null, 2);
  buyBtn.click();
  await sleep(900);

  const sheet = document.querySelector('.sheet');
  step('下单弹层已弹出', sheet);
  if (!sheet) return JSON.stringify(out, null, 2);

  const inputs = sheet.querySelectorAll('.input');
  const priceInput = inputs[0];
  const volumeInput = inputs[1];
  out.prefilledPrice = priceInput?.value;
  step('价格已按最新价预填', Number(out.prefilledPrice) > 0, `price=${out.prefilledPrice}`);
  step('显示最大可买数量', /最大可买/.test(sheet.textContent), sheet.querySelector('.sheet-sub')?.textContent);
  step(
    '提供 最新/涨停/跌停 快捷价',
    /最新/.test(sheet.textContent) && /涨停/.test(sheet.textContent) && /跌停/.test(sheet.textContent),
  );
  step('提供 全部/1-2/1-3 快捷量', /全部/.test(sheet.textContent) && /1\/2/.test(sheet.textContent));

  // ---- 2. 共享校验函数的即时提示：填一个超出价格笼子的价
  setNativeInput(volumeInput, '100');
  await sleep(200);
  const cagePrice = Math.round(Number(out.prefilledPrice) * 1.05 * 100) / 100;
  setNativeInput(priceInput, String(cagePrice));
  await sleep(500);
  out.cageErrorText = sheet.querySelector('.form-error')?.textContent ?? '';
  step('超价格笼子被即时拦截', /102%/.test(out.cageErrorText), out.cageErrorText);

  // ---- 3. 改回合理价格：报错消失并出现金额/费用预览
  setNativeInput(priceInput, out.prefilledPrice);
  await sleep(500);
  step('价格改回后报错消失', !sheet.querySelector('.form-error'));
  step(
    '出现预计金额与费用预览',
    /预计金额/.test(sheet.textContent) && /预计费用/.test(sheet.textContent),
  );

  // ---- 4. 二次确认
  const nextBtn = [...sheet.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '下一步');
  step('存在「下一步」按钮', nextBtn);
  if (nextBtn) nextBtn.click();
  await sleep(500);
  const confirm = sheet.querySelector('.confirm-box');
  step('进入二次确认态', confirm);
  step(
    '确认页含委托类型/价格/数量/金额',
    ['委托类型', '委托价格', '委托数量', '预计金额', '预计费用'].every((k) =>
      (confirm?.textContent ?? '').includes(k),
    ),
  );
  step('确认页含 T+1 风险提示', /T\+1/.test(confirm?.textContent ?? ''));

  // ---- 5. 下单 + 幂等（走接口，避免与受控输入较劲）
  const orderPrice = Math.round(Number(out.prefilledPrice) * 1.008 * 100) / 100;
  const cid = `vis-${Date.now().toString(36)}`;
  const payload = {
    clientOrderId: cid,
    symbol: '600519.SH',
    side: 'buy',
    type: 'limit',
    price: orderPrice,
    volume: 100,
  };
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  out.orderId = body.order?.orderId;
  out.firstStatus = res.status;
  step('接口下单受理成功', res.status === 200, `HTTP ${res.status} ${out.orderId ?? ''}`);

  await sleep(300);
  const res2 = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body2 = await res2.json();
  step(
    '同幂等键重复提交被判为命中',
    body2.deduplicated === true && body2.order?.orderId === out.orderId,
    `dedup=${body2.deduplicated} id=${body2.order?.orderId}`,
  );

  // ---- 6. 交易页实时反映
  sheet.querySelector('.icon-btn')?.click();
  await sleep(300);
  location.hash = '#/trade';
  await sleep(2600);

  const page = document.body.textContent;
  step('交易页出现账户概览', /总资产/.test(page) && /可用资金/.test(page));
  step('交易页出现持仓区', /持仓/.test(page));
  step('交易页出现当日委托', /当日委托/.test(page));
  step('交易页出现当日成交', /当日成交/.test(page));
  step('委托列表已渲染', document.querySelectorAll('.order-row').length > 0, `${document.querySelectorAll('.order-row').length} 行`);

  const tradeRows = [...document.querySelectorAll('.trade-row')];
  out.holdingRows = tradeRows.length;
  step('持仓/成交列表已渲染', tradeRows.length > 0, `${tradeRows.length} 行`);
  step('持仓含贵州茅台', tradeRows.some((r) => r.textContent.includes('贵州茅台')));

  const orders = await fetch('/api/orders').then((r) => r.json());
  const mine = orders.find((o) => o.orderId === out.orderId);
  out.serverOrder = mine ? { status: mine.status, filled: mine.filledVolume } : null;
  step('服务端委托存在且状态已推进', Boolean(mine) && mine.status !== 'pending_new', JSON.stringify(out.serverOrder));

  const sealed = await fetch('/api/orders').then((r) => r.json());
  out.totalOrders = sealed.length;
  out.totalTrades = (await fetch('/api/trades').then((r) => r.json())).length;

  out.failed = out.steps.filter((s) => !s.ok).length;
  out.total = out.steps.length;
  return JSON.stringify(out, null, 2);
})();
