import { useEffect, useMemo } from 'react';
import type { Instrument } from '@stock/market-core';
import { QuoteRow } from '../components/QuoteRow';
import { useInstruments } from '../store';
import { acquire, release } from '../net';

/**
 * 市场页：展示全部标的。
 *
 * 这里会订阅**所有**标的，和自选页形成对比 ——
 * 用来验证细粒度订阅的效果：30 只票同时在跳，但只有真的变化的那几行会重渲染。
 * 想看证据就打开 React DevTools 的 "Highlight updates when components render"。
 */
export function MarketsPage() {
  const instruments = useInstruments();

  useEffect(() => {
    const all = [...instruments.keys()];
    if (all.length === 0) return;
    all.forEach(acquire);
    return () => all.forEach(release);
  }, [instruments]);

  const groups = useMemo(() => {
    const list = [...instruments.values()];
    return [
      { title: '沪市主板 / 科创板', items: list.filter((i) => i.market === 'SH' && i.board !== 'index') },
      { title: '深市主板 / 创业板', items: list.filter((i) => i.market === 'SZ' && i.board !== 'index') },
      { title: '指数', items: list.filter((i) => i.board === 'index') },
    ].filter((g) => g.items.length > 0);
  }, [instruments]);

  if (groups.length === 0) return <div className="empty">加载中…</div>;

  return (
    <>
      {groups.map((g) => (
        <div className="card" key={g.title}>
          <div className="card-head">
            {g.title}
            <span className="sub">{g.items.length} 只</span>
          </div>
          <div className="list-head">
            <span>名称 / 代码</span>
            <span className="c-price">最新价</span>
            <span className="c-chg">涨跌幅</span>
          </div>
          {g.items.map((i: Instrument) => (
            <QuoteRow key={i.symbol} symbol={i.symbol} inst={i} />
          ))}
        </div>
      ))}
    </>
  );
}
