import type { CavilApi } from '../shared/ipc';

declare global {
  interface Window {
    cavil: CavilApi;
  }
}

export const api = (): CavilApi => window.cavil;
