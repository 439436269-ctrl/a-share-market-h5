import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { bootstrap } from './net';
import './styles.css';

// 连接是应用级单例，在 React 之外建立 —— 不随组件挂载/卸载重建
void bootstrap();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
