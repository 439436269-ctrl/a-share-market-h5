import { useEffect, useMemo, useState } from 'react';
import {
  PHASE_LABEL,
  amplitude,
  fmtAmount,
  fmtChange,
  fmtPct,
  fmtPrice,
  fmtVolume,
  limitLabel,
  turnoverRate,
} from '@stock/market-core';
import type { Bar, OrderSide, Period } from '@stock/market-core';
import { KLineChart } from '../chart/KLineChart';
import { TimeShareChart } from '../chart/TimeShareChart';
import { DepthPanel, TickList } from '../chart/DepthPanel';
import { OrderSheet } from '../components/OrderSheet';
import { useInstruments, useQuote, useTicks } from '../store';
import { useAccount } from '../tradingStore';
import { acquire, fetchKline, release } from '../net';

const TABS: Array<{ key: Period; label: string }> = [
  { key: '1m', label: '分时' },
  { key: '5m', label: '5分' },
  { key: '15m', label: '15分' },
  { key: '60m', label: '60分' },
  { key: '1d', label: '日K' },
];

/**
 * K 线数据获取。
 *
 * 这里刻意跟实时行情走了**两条不同的链路**：
 *   - 实时快照（价格/盘口）走 WebSocket，因为它小、频繁、要求低延迟；
 *   - K 线这种聚合数据走 REST 轮询，因为它大、低频、且不需要毫秒级一致。
 * 把 K 线塞进 WS 会让每一帧都背上几十 KB 的聚合数据，是典型的自找麻烦。
 */
function useKline(symbol: string, period: Period): Bar[] {
  const [bars, setBars] = useState<Bar[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const next = await fetchKline(symbol, period, period === '1d' ? 160 : 240);
      if (alive) setBars(next);
    };
    void load();
    const timer = setInterval(load, period === '1d' ? 10_000 : 2_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [symbol, period]);
  return bars;
}

export function DetailPage({ symbol }: { symbol: string }) {
  const instruments = useInstruments();
  const inst = instruments.get(symbol) ?? undefined;
  const quote = useQuote(symbol);
  const ticks = useTicks(symbol);

  const [period, setPeriod] = useState<Period>('1m');
  const [toast, setToast] = useState('');
  const [orderSide, setOrderSide] = useState<OrderSide | null>(null);
  const account = useAccount();
  const position = account?.positions.find((p) => p.symbol === symbol);
  const bars = useKline(symbol, period);

  // 进入详情页才订阅这只票，离开就退订（引用计数保证不误伤自选）
  useEffect(() => {
    acquire(symbol);
    return () => release(symbol);
  }, [symbol]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  const pct = quote?.changePct ?? 0;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const tag = quote ? limitLabel(quote) : null;

  const kv = useMemo(() => {
    if (!quote) return [];
    const rows: Array<[string, string, string?]> = [
      ['今开', fmtPrice(quote.open), quote.open >= quote.prevClose ? 'dir-up' : 'dir-down'],
      ['最高', fmtPrice(quote.high), 'dir-up'],
      ['最低', fmtPrice(quote.low), 'dir-down'],
      ['昨收', fmtPrice(quote.prevClose)],
      ['成交量', fmtVolume(quote.volume)],
      ['成交额', fmtAmount(quote.amount)],
      ['换手率', `${(turnoverRate(quote, inst) * 100).toFixed(2)}%`],
      ['振幅', `${(amplitude(quote) * 100).toFixed(2)}%`],
      ['涨停', fmtPrice(quote.limitUp), 'dir-up'],
      ['跌停', fmtPrice(quote.limitDown), 'dir-down'],
    ];
    return rows;
  }, [quote, inst]);

  const tradable = quote?.phase === 'continuous' || quote?.phase === 'close_auction';

  if (!inst && !quote) {
    return <div className="empty">加载中…</div>;
  }

  return (
    <>
      <div className="hero">
        <div className="hero-top">
          <div className={`hero-price dir-${dir}`}>{fmtPrice(quote?.last)}</div>
          <div className={`hero-sub dir-${dir}`}>
            <span>{fmtChange(quote?.change ?? 0)}</span>
            <span>{fmtPct(pct)}</span>
            {tag && <span className={`chip ${tag === '涨停' ? 'up' : tag === '跌停' ? 'down' : ''}`}>{tag}</span>}
          </div>
        </div>
        <div className="hero-meta">
          <span>
            {inst?.name} {symbol}
          </span>
          <span>{quote ? PHASE_LABEL[quote.phase] : '--'}</span>
          <span>更新于 {quote ? new Date(quote.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '--'}</span>
        </div>
      </div>

      <div className="card">
        <div className="segmented">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`seg ${period === t.key ? 'active' : ''}`}
              onClick={() => setPeriod(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {period === '1m' ? (
          <TimeShareChart bars={bars} prevClose={quote?.prevClose ?? inst?.prevClose ?? 0} />
        ) : (
          <KLineChart bars={bars} />
        )}
        <div className="kv-grid">{kv.map(([k, v, cls]) => (
          <div className="kv" key={k}>
            <div className="k">{k}</div>
            <div className={`v ${cls ?? ''}`}>{v}</div>
          </div>
        ))}</div>
      </div>

      <div className="card">
        <div className="card-head">
          盘口
          <span className="sub">五档 · 成交明细</span>
        </div>
        <div className="depth-grid">
          <DepthPanel quote={quote} />
          <TickList ticks={ticks} />
        </div>
      </div>

      <div className="card">
        <div className="trade-actions" style={{ paddingTop: 12 }}>
          <button className="btn btn-primary" disabled={!tradable} onClick={() => setOrderSide('buy')}>
            买入
          </button>
          <button className="btn btn-primary sell" disabled={!tradable} onClick={() => setOrderSide('sell')}>
            卖出
          </button>
        </div>
        <div className="trade-meta">
          <span>
            持仓 <b>{position?.volume ?? 0}</b> 股
          </span>
          <span>
            可用 <b>{position?.available ?? 0}</b> 股
          </span>
          {!tradable && (
            <span className="warn">
              {quote ? PHASE_LABEL[quote.phase] : '非交易时段'}，不可下单
            </span>
          )}
        </div>
        {!tradable && (
          <div className="trade-note">
            交易状态由服务端下发，不由前端本地时间猜测 —— 否则会出现"服务端说收盘了、按钮还是亮的"
          </div>
        )}
      </div>

      {orderSide && (
        <OrderSheet
          symbol={symbol}
          side={orderSide}
          onClose={() => setOrderSide(null)}
          onToast={setToast}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
