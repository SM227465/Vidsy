import '@src/index.css';
import Popup from '@src/Popup';
import { createRoot } from 'react-dom/client';

// Dimension override for the standalone window (#download-details). The
// primary override lives in popup/index.html as an inline <script> that
// sets the --vidsy-popup-* CSS variables on document.documentElement
// before index.css ever parses, so first paint already uses the standalone
// dimensions and there is no flash. We mirror the assignment here as a
// belt-and-suspenders pass — if the inline script is ever stripped by a
// build pipeline change, this still catches it (with a visible flash
// while the JS bundle downloads, but no permanent stuck-at-380px state).
if (typeof window !== 'undefined' && window.location.hash === '#download-details') {
  const r = document.documentElement.style;
  r.setProperty('--vidsy-popup-w', '100%');
  r.setProperty('--vidsy-popup-h', '100%');
  r.setProperty('--vidsy-popup-min-h', '0');
  r.setProperty('--vidsy-popup-max-h', 'none');
  r.setProperty('--vidsy-popup-overflow', 'visible');
}

const init = () => {
  const appContainer = document.querySelector('#app-container');
  if (!appContainer) {
    throw new Error('Can not find #app-container');
  }
  const root = createRoot(appContainer);

  root.render(<Popup />);
};

init();
