// Before the suites: this run's own temporary folder (GitHub#469, test/support/tmp-root.mjs — a
// no-op under `npm test`, which already runs inside one), then build the Rust back end the suites
// drive (src-tauri/crates/harness) once per run. The returned teardown removes the folder.
import { buildHarness } from '../support/harness';
import { directRun } from '../support/tmp-root.mjs';

export default async function setup() {
  const done = await directRun();
  buildHarness();
  return done;
}
