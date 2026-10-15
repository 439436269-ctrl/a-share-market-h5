/**
 * 五档盘口 + 成交明细。
 *
 * 盘口这块最容易被忽略、但最能体现业务理解：
 *
 *  1. **封涨停时卖盘为空、买一巨量排队**；封跌停反之。
 *     这不是"数据缺失"，而是市场状态的正确表达 —— 显示 '--' 是对的，补 0 是错的。
 *  2. 挂单量用**背景条**表达相对厚度，用户扫一眼就知道哪一档厚。
 *  3. 价格颜色按**与昨收比较**着色（高于昨收红 / 低于绿），而不是按买卖方向着色。
 *     这是国内行情软件的既定习惯。
 *  4. 成交明细的最新一笔在最上，方向用颜色区分主动买/主动卖 ——
 *     side 是交易所给的"主动方"（外盘/内盘语义），不是我们猜的。
 */
import { fmtPrice, fmtTime, fmtVolume } from '@stock/market-core';
import type { Quote, Tick } from '@stock/market-core';

function numClass(price: number, prevClose: number): string {
  if (!price || !prevClose) return 'dir-flat';
  if (price > prevClose) return 'dir-up';
  if (price < prevClose) return 'dir-down';
  return 'dir-flat';
}

export interface DepthPanelProps {
  quote: Quote | undefined;
}

export function DepthPanel({ quote }: DepthPanelProps) {
  if (!quote) {
    return <div className="empty">等待盘口数据…</div>;
  }

  const prevClose = quote.prevClose;
  // 卖盘倒序显示：卖五 → 卖一（越靠近现价越靠下），符合行情软件视觉习惯
  const asks = [...quote.asks]
    .map((level, i) => ({ ...level, label: `卖${['一', '二', '三', '四', '五'][i]}` }))
    .reverse();
  const bids = quote.bids.map((level, i) => ({
    ...level,
    label: `买${['一', '二', '三', '四', '五'][i]}`,
  }));

  // 背景条按"全盘口最大挂单量"归一，买卖两侧共用同一把尺子，否则厚度不可比
  const maxVol = Math.max(
    1,
    ...quote.asks.map((l) => l.volume),
    ...quote.bids.map((l) => l.volume),
  );

  const rows = [...asks, ...bids];

  return (
    <div className="depth-col">
      {rows.map((r, i) => {
        const pct = (r.volume / maxVol) * 100;
        const isAsk = i < asks.length;
        return (
          <div className="depth-row" key={r.label}>
            <span className={`depth-bar ${isAsk ? 'down' : 'up'}`} style={{ width: `${pct}%` }} />
            <span className="label">{r.label}</span>
            <span className={`price ${numClass(r.price, prevClose)}`}>
              {r.price > 0 ? fmtPrice(r.price) : '--'}
            </span>
            <span className="vol">{r.volume > 0 ? fmtVolume(r.volume) : '--'}</span>
          </div>
        );
      })}
    </div>
  );
}

export interface TickListProps {
  ticks: Tick[];
}

export function TickList({ ticks }: TickListProps) {
  if (ticks.length === 0) {
    return <div className="empty">等待成交…</div>;
  }
  return (
    <div className="tick-list">
      {ticks.map((t, i) => (
        <div className="tick-row" key={`${t.ts}-${i}-${t.price}-${t.volume}`}>
          <span className="t">{fmtTime(t.ts)}</span>
          <span className={`p dir-${t.side === 'B' ? 'up' : t.side === 'S' ? 'down' : 'flat'}`}>
            {fmtPrice(t.price)}
          </span>
          <span className="v">{fmtVolume(t.volume)}</span>
        </div>
      ))}
    </div>
  );
}
