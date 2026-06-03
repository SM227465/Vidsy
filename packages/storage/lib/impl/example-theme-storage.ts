import { createStorage, StorageEnum } from '../base/index.js';
import type { ThemeStateType, ThemeStorageType } from '../base/index.js';

// First-run default tracks the user's OS preference via the
// prefers-color-scheme media query. After the user toggles the theme
// manually, the stored value wins and this fallback is no longer
// consulted. Wrapped in a try because some extension contexts (service
// worker, web worker) don't expose window.matchMedia and would throw
// at module load time.
const systemPrefersDark = (() => {
  try {
    return (
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as { matchMedia?: typeof matchMedia }).matchMedia === 'function' &&
      (globalThis as { matchMedia: typeof matchMedia }).matchMedia('(prefers-color-scheme: dark)').matches
    );
  } catch {
    return false;
  }
})();

const storage = createStorage<ThemeStateType>(
  'theme-storage-key',
  {
    theme: systemPrefersDark ? 'dark' : 'light',
    isLight: !systemPrefersDark,
  },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const exampleThemeStorage: ThemeStorageType = {
  ...storage,
  toggle: async () => {
    await storage.set(currentState => {
      const newTheme = currentState.theme === 'light' ? 'dark' : 'light';

      return {
        theme: newTheme,
        isLight: newTheme === 'light',
      };
    });
  },
};
