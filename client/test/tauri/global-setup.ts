// This run's own temporary folder (GitHub#469, test/support/tmp-root.mjs — a no-op under
// `npm run test:tauri`, which already runs inside one). The returned teardown removes the folder.
import { directRun } from '../support/tmp-root.mjs';

export default async function setup() {
  return directRun();
}
