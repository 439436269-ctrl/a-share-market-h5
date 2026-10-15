/**
 * 详情页渲染核验。
 *
 * 图表这类 Canvas 自绘最容易出的问题是"看着有框、其实没画"，
 * 所以这里直接**数非透明像素**，把"画出来了"变成可断言的事实。
 * 同时核验盘口 10 档、成交明细、指标区字段、以及非交易时段按钮是否被禁用。
 */
(() => {
  const canvas = document.querySelector('.chart-wrap canvas');
  let painted = 0;
  let canvasInfo = null;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
    canvasInfo = {
      w: canvas.width,
      h: canvas.height,
      paintedPixels: painted,
      paintedRatio: Number((painted / (canvas.width * canvas.height)).toFixed(4)),
    };
  }

  const priceTexts = [...document.querySelectorAll('.depth-row .price')].map((e) => e.textContent.trim());

  return JSON.stringify(
    {
      heroPrice: document.querySelector('.hero-price')?.textContent?.trim(),
      heroSub: document.querySelector('.hero-sub')?.textContent?.trim(),
      heroMeta: document.querySelector('.hero-meta')?.textContent?.trim(),
      activeTab: document.querySelector('.seg.active')?.textContent,
      canvas: canvasInfo,
      depthRowCount: document.querySelectorAll('.depth-row').length,
      depthTop5: priceTexts.slice(0, 5),
      depthBottom5: priceTexts.slice(5, 10),
      tickRowCount: document.querySelectorAll('.tick-row').length,
      kv: [...document.querySelectorAll('.kv')].map(
        (k) => `${k.querySelector('.k').textContent}=${k.querySelector('.v').textContent}`,
      ),
      buttons: [...document.querySelectorAll('.btn')].map((b) => ({
        text: b.textContent.trim(),
        disabled: b.disabled,
      })),
    },
    null,
    2,
  );
})();
