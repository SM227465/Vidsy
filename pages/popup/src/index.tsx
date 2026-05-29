import '@src/index.css';
import Popup from '@src/Popup';
import { createRoot } from 'react-dom/client';

// When loaded as a standalone window via chrome.windows.create (the download
// interceptor uses #download-details), override the popup's hardcoded 380×600
// dimensions so the details view fills the larger window.
if (typeof window !== 'undefined' && window.location.hash === '#download-details') {
  const fill = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.minWidth = '0';
    el.style.maxWidth = 'none';
    el.style.minHeight = '0';
    el.style.maxHeight = 'none';
  };
  fill(document.documentElement);
  fill(document.body);
  fill(document.getElementById('app-container'));
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
