import { ConnectionBar } from './components/ConnectionBar';
import { DetailPage } from './pages/DetailPage';
import { MarketsPage } from './pages/MarketsPage';
import { ProfilePage } from './pages/ProfilePage';
import { WatchlistPage } from './pages/WatchlistPage';
import { useInstruments } from './store';
import { navigate, useRoute } from './router';
import type { Route } from './router';

const TAB_TITLES: Record<Exclude<Route['name'], 'detail'>, string> = {
  watchlist: '行情',
  markets: '市场',
  profile: '我的',
};

export default function App() {
  const route = useRoute();
  const instruments = useInstruments();
  const isDetail = route.name === 'detail';

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
