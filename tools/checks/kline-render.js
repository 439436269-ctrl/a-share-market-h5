/**
 * 切到日 K 视图并等数据到位，然后核验蜡烛图确实画出来了。
 * 用 --eval-file 配合 --out 使用：eval 先执行（点击 + 等待），再截图。
 */
(async () => {
  const segs = [...document.querySelectorAll('.seg')];
  const target = segs.find((s) => s.textContent.trim() === '日K');
  if (!target) return JSON.stringify({ error: '未找到日K Tab', tabs: segs.map((s) => s.textContent) });
  target.click();

  // 等 REST 把日线数据取回来并重绘
  await new Promise((r) => setTimeout(r, 3000));

  const canvas = document.querySelector('.chart-wrap canvas');
  if (!canvas) return JSON.stringify({ error: 'K线 canvas 不存在' });

  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height).data;

  // 统计涨/跌色的像素量：蜡烛图应该有大量红绿实体
  let red = 0;
  let green = 0;
  let orange = 0; // MA5
  for (let i = 0; i < img.length; i += 4) {
    if (img[i + 3] < 40) continue;
    const r = img[i];
    const g = img[i + 1];
    const b = img[i + 2];
    if (Math.abs(r - 0xfa) < 26 && Math.abs(g - 0x51) < 26) red += 1;
    else if (Math.abs(g - 0xbe) < 26 && Math.abs(r - 0x2f) < 26) green += 1;
    else if (Math.abs(r - 0xf0) < 26 && Math.abs(g - 0xa0) < 26) orange += 1;
  }

  const res = await fetch('/api/kline?symbol=600519.SH&period=1d&limit=160');
  const bars = (await res.json()).bars ?? [];

  return JSON.stringify(
    {
      activeTab: document.querySelector('.seg.active')?.textContent,
      dailyBarsFromApi: bars.length,
      firstDailyBar: bars[0] ? new Date(bars[0].ts).toISOString().slice(0, 10) : null,
      lastDailyClose: bars.length ? bars[bars.length - 1].close : null,
      candleRedPixels: red,
      candleGreenPixels: green,
      maOrangePixels: orange,
      verdict:
        red + green > 500 && orange > 100 && bars.length > 50
          ? 'OK：蜡烛与均线均已绘制，日线数据完整'
          : 'SUSPECT：蜡烛/均线像素过少或日线数据不足',
    },
    null,
    2,
  );
})();
