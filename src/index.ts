import { registerPlugin } from '@capacitor/core';

import type { SolanaMwaPlugin } from './definitions';

const SolanaMwa = registerPlugin<SolanaMwaPlugin>('SolanaMwa', {
  web: () => import('./web').then(m => new m.SolanaMwaWeb()),
});

export * from './definitions';
export { SolanaMwa };
