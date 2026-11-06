// The UI tests drive the real back end (src-tauri/crates/harness): build it once per run.
import { buildHarness } from '../support/harness';

export default function setup() {
  buildHarness();
}
