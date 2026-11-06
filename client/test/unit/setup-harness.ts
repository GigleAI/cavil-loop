// Build the Rust back end the suites drive (src-tauri/crates/harness) once per run.
import { buildHarness } from '../support/harness';

export default function setup() {
  buildHarness();
}
