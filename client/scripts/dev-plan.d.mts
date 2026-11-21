export declare const CLIENT_INPUTS: string[];
type Hidden = { tag: string; version: string; kind: 'tag' | 'draft'; sha: string | null } | null;
type Tag = string | { name: string; sha: string | null };
export declare function hiddenBuild(list: unknown[], tags: Tag[]): Hidden;
export declare function latestBuild(
  list: unknown[],
  tags?: Tag[] | 'unreadable',
): { tag?: string; sha?: string | null; complete?: boolean; state?: 'complete' | 'incomplete' | 'unknown'; none?: boolean; tagCheck?: 'ok' | 'absent' | 'mismatch' | 'unknown' | null; hidden: Hidden; tags: 'ok' | 'unreadable' } | null;
export declare function readTags(repo: string): { name: string; sha: string | null }[];
export declare function clientChanged(base: string, head: string, root?: string): boolean | null;
export declare function plan(a: {
  latest: { tag?: string; sha?: string | null; complete?: boolean; state?: string; tagCheck?: string | null; none?: boolean; hidden?: Hidden; tags?: string } | null | 'unreadable';
  head: string;
  force: boolean;
  changed: boolean | null | ((base: string, head: string) => boolean | null);
}): { build: boolean; why: string };
export declare function tagOnList(tags: Tag[], tag: string, sha: string): 'ok' | 'absent' | 'mismatch' | 'unknown';
