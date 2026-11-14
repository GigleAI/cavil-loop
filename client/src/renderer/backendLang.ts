// GitHub#473: a number that changes each time the back end takes a new language (see
// noteBackendLang in shared/i18n.ts). A part of the window that shows a status the back end worded
// lists it among an effect's dependencies, so that status is read again in the new language.

import { useSyncExternalStore } from 'react';
import { backendLangRound, onBackendLang } from '../shared/i18n';

export function useBackendLangRound(): number {
  return useSyncExternalStore(onBackendLang, backendLangRound, backendLangRound);
}
