import { useEffect, useState } from 'react';

/**
 * 极简 hash 路由。
 *
 * 行情 H5 里没必要上 react-router：路由形态就三种（列表/详情/我的），
 * 而且 Hybrid 容器里 hash 路由比 history 路由更稳（不依赖服务端 rewrite）。
 */
export type Route =
  | { name: 'watchlist' }
  | { name: 'markets' }
  | { name: 'trade' }
  | { name: 'profile' }
  | { name: 'detail'; symbol: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  if (raw.startsWith('stock/')) {
    const symbol = decodeURIComponent(raw.slice('stock/'.length));
    if (symbol) return { name: 'detail', symbol };
  }
  if (raw === 'market') return { name: 'markets' };
  if (raw === 'trade') return { name: 'trade' };
  if (raw === 'me') return { name: 'profile' };
  return { name: 'watchlist' };
}

export function navigate(to: string): void {
  if (window.location.hash === to) return;
  window.location.hash = to;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseRoute(hash);
}
