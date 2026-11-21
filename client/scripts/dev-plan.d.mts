export declare const CLIENT_INPUTS: string[];
export declare function latestBuild(list: unknown[]): { tag: string; sha: string | null } | null;
export declare function clientChanged(base: string, head: string, root?: string): boolean | null;
export declare function plan(a: {
  latest: { tag: string; sha: string | null } | null | 'unreadable';
  head: string;
  force: boolean;
  changed: boolean | null | ((base: string, head: string) => boolean | null);
}): { build: boolean; why: string };
