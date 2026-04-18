import inlineCss from '../../../dist/all/index.css?inline';
import { initAppWithShadow } from '@extension/shared';
import App from '@src/matches/all/App';

const HOST_ID = 'CEB-extension-all';

initAppWithShadow({ id: HOST_ID, app: <App />, inlineCss });

// Make the host cover the full viewport, pointer-events passthrough
const host = document.getElementById(HOST_ID);
if (host) {
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
}
