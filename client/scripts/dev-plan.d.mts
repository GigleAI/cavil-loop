export declare const CLIENT_INPUTS: string[];
type Hidden = { tag: string; version: string; kind: 'tag' | 'draft' } | null;
export declare function hiddenBuild(list: unknown[], tags: string[]): Hidden;
export declare function latestBuild(
  list: unknown[],
  tags?: string[] | 'unreadable',
): { tag?: string; sha?: string | null; complete?: boolean; state?: 'complete' | 'incomplete' | 'unknown'; none?: boolean; hidden: Hidden; tags: 'ok' | 'unreadable' } | null;
export declare function readTags(repo: string): string[];
export declare function clientChanged(base: string, head: string, root?: string): boolean | null;
export declare function plan(a: {
  latest: { tag?: string; sha?: string | null; complete?: boolean; state?: string; none?: boolean; hidden?: Hidden; tags?: string } | null | 'unreadable';
  head: string;
  force: boolean;
  changed: boolean | null | ((base: string, head: string) => boolean | null);
}): { build: boolean; why: string };
