import { ConnectionBar } from './components/ConnectionBar';
import { DetailPage } from './pages/DetailPage';
import { MarketsPage } from './pages/MarketsPage';
import { ProfilePage } from './pages/ProfilePage';
import { TradePage } from './pages/TradePage';
import { WatchlistPage } from './pages/WatchlistPage';
import { useInstruments } from './store';
import { useOrders } from './tradingStore';
import { navigate, useRoute } from './router';
import type { Route } from './router';

const TAB_TITLES: Record<Exclude<Route['name'], 'detail'>, string> = {
  watchlist: '行情',
  markets: '市场',
  trade: '交易',
  profile: '我的',
};

export default function App() {
  const route = useRoute();
  const instruments = useInstruments();
  const orders = useOrders();
  const isDetail = route.name === 'detail';
  // 有可撤委托时在 Tab 上打个点，让用户知道有单挂着
  const activeOrderCount = orders.filter((o) => o.status === 'new' || o.status === 'partially_filled').length;

  const title = isDetail
    ? (instruments.get(route.symbol)?.name ?? route.symbol)
    : TAB_TITLES[route.name];

  const activeTab = isDetail ? 'watchlist' : route.name;

  return (
    <div className="app-shell">
      <div className="topbar">
        {isDetail && (
          <button className="icon-btn" onClick={() => navigate('#/')} aria-label="返回">
            ‹
          </button>
        )}
        <div className="topbar-title">{title}</div>
        {isDetail && (
          <button
            className="icon-btn"
            onClick={() => navigate(`#/stock/${encodeURIComponent(route.symbol)}`)}
            aria-label="刷新"
            style={{ fontSize: 14 }}
          >
            ⟳
          </button>
        )}
      </div>

      <ConnectionBar />

      <div className="content">
        {route.name === 'watchlist' && <WatchlistPage />}
        {route.name === 'markets' && <MarketsPage />}
        {route.name === 'trade' && <TradePage />}
        {route.name === 'profile' && <ProfilePage />}
        {route.name === 'detail' && <DetailPage symbol={route.symbol} />}
      </div>

      <nav className="tabbar">
        <button
          className={`tab ${activeTab === 'watchlist' ? 'active' : ''}`}
          onClick={() => navigate('#/')}
        >
          <span className="ico">★</span>
          自选
        </button>
        <button
          className={`tab ${activeTab === 'markets' ? 'active' : ''}`}
          onClick={() => navigate('#/market')}
        >
          <span className="ico">▤</span>
          行情
        </button>
        <button
          className={`tab ${activeTab === 'trade' ? 'active' : ''}`}
          onClick={() => navigate('#/trade')}
        >
          <span className="ico">⇄</span>
          交易
          {activeOrderCount > 0 && <span className="tab-dot">{activeOrderCount}</span>}
        </button>
        <button
          className={`tab ${activeTab === 'profile' ? 'active' : ''}`}
          onClick={() => navigate('#/me')}
        >
          <span className="ico">◍</span>
          我的
        </button>
      </nav>
    </div>
  );
}
