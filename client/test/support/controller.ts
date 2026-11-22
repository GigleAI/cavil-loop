// GitHub#649: every test builds its controller here. The client's read retries (1 s, then 3 s, see
// READ_RETRY_DELAYS_MS) do not sleep in tests: the controller is handed a recorder that notes each
// wait it asks for and returns at once. How many tries, and which failures are tried again, stay the
// product's own decision. A test that times the retries itself passes its own `readRetrySleep`
// (and / or `readRetryDelaysMs`), which is kept as given.

import { Controller, type ControllerDeps } from '../../src/app/controller';

const waits = new WeakMap<Controller, number[]>();

export async function createController(deps: ControllerDeps): Promise<Controller> {
  const seen: number[] = [];
  const own = deps.readRetrySleep !== undefined;
  const c = await Controller.create(
    own
      ? deps
      : {
          ...deps,
          readRetrySleep: async (ms: number) => {
            seen.push(ms);
          },
        },
  );
  waits.set(c, seen);
  return c;
}

/** The read-retry waits the controller asked for, in order (empty when the test brought its own sleep). */
export function readRetryWaits(c: Controller): number[] {
  return waits.get(c) ?? [];
}
