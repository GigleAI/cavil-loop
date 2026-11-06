// A minimal W3C WebDriver client for the real Tauri app (GitHub#151 review): tauri-driver
// on 127.0.0.1:4444 hands the session to WebKitWebDriver, which drives the app's own
// system-WebKit window. Only the handful of commands the real-window test needs.

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export class WebDriver {
  private session = '';
  constructor(private readonly base = 'http://127.0.0.1:4444') {}

  private async cmd<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as { value: any };
    if (!res.ok) throw new Error(`WebDriver ${method} ${path}: ${res.status} ${JSON.stringify(json.value).slice(0, 400)}`);
    return json.value as T;
  }

  /** Start the app (the binary at `application`); it runs with this process's environment. */
  async start(application: string): Promise<void> {
    const v = await this.cmd<{ sessionId: string }>('POST', '/session', {
      capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application } } },
    });
    this.session = v.sessionId;
  }

  async stop(): Promise<void> {
    if (this.session) await this.cmd('DELETE', `/session/${this.session}`).catch(() => {});
    this.session = '';
  }

  private s(path: string) {
    return `/session/${this.session}${path}`;
  }

  /** Wait until `css` matches (in the current frame); returns the element id. */
  async find(css: string, timeoutMs = 20_000): Promise<string> {
    const end = Date.now() + timeoutMs;
    let last = '';
    for (;;) {
      try {
        const v = await this.cmd<Record<string, string>>('POST', this.s('/element'), { using: 'css selector', value: css });
        return v[ELEMENT];
      } catch (e) {
        last = (e as Error).message;
      }
      if (Date.now() > end) throw new Error(`not found: ${css} (${last})`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async count(css: string): Promise<number> {
    const v = await this.cmd<Record<string, string>[]>('POST', this.s('/elements'), { using: 'css selector', value: css });
    return v.length;
  }

  async click(css: string): Promise<void> {
    await this.cmd('POST', this.s(`/element/${await this.find(css)}/click`), {});
  }

  async type(css: string, text: string): Promise<void> {
    const id = await this.find(css);
    await this.cmd('POST', this.s(`/element/${id}/clear`), {});
    await this.cmd('POST', this.s(`/element/${id}/value`), { text });
  }

  async text(css: string): Promise<string> {
    return this.cmd('GET', this.s(`/element/${await this.find(css)}/text`));
  }

  async url(): Promise<string> {
    return this.cmd('GET', this.s('/url'));
  }

  async exec<T = any>(script: string, args: unknown[] = []): Promise<T> {
    return this.cmd('POST', this.s('/execute/sync'), { script, args });
  }

  /** Into the iframe matching `css`, or back to the top document with null. */
  async frame(css: string | null): Promise<void> {
    if (css === null) return void (await this.cmd('POST', this.s('/frame'), { id: null }));
    const id = await this.find(css);
    await this.cmd('POST', this.s('/frame'), { id: { [ELEMENT]: id } });
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.cmd<string>('GET', this.s('/screenshot')), 'base64');
  }
}

/** Poll `fn` until it returns true. */
export async function until(fn: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
