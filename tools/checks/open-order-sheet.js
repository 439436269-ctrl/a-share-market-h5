/**
 * 只把下单弹层打开并填好数量，停在那里等截图（配合 --out 使用）。
 * 与 trading-flow.js 的区别：它不做提交，专门用来出图。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#/stock/600519.SH';
  await sleep(2800);

  const buyBtn = [...document.querySelectorAll('.trade-actions .btn')].find(
    (b) => b.textContent.trim() === '买入',
  );
  buyBtn?.click();
  await sleep(1000);

  const sheet = document.querySelector('.sheet');
  if (!sheet) return JSON.stringify({ ok: false, reason: '弹层未出现' });

  const inputs = sheet.querySelectorAll('.input');
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  desc.set.call(inputs[1], '100');
  inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(600);

  return JSON.stringify({
    ok: true,
    price: inputs[0]?.value,
    volume: inputs[1]?.value,
    preview: sheet.querySelector('.form-preview')?.textContent ?? '',
  });
})();
