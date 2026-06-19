import React from 'react';
import ReactDOM from 'react-dom/client';
import './main.css';
import SnapWeb from './components/SnapWeb';
import Headless from './components/Headless';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

console.log(`Welcome to ${import.meta.env.VITE_APP_NAME} ${import.meta.env.VITE_APP_VERSION}`)

const isHeadless = window.location.hash.includes('headless');

root.render(
  <React.StrictMode>
    {isHeadless ? <Headless /> : <SnapWeb />}
  </React.StrictMode>
);
