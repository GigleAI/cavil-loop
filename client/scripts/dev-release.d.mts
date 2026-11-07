export declare const TAG_PREFIX: string;
export declare function parseDev(v: string): [number, number, number, number] | null;
export interface DevRelease {
  tag: string;
  version: string;
  parsed: [number, number, number, number];
}
export declare function devReleases(list: unknown[]): DevRelease[];
export declare function decide(list: unknown[], version: string, files: string[]): { action: 'skip'; why: string } | { action: 'done' } | { action: 'create' } | { action: 'fill'; draft: boolean };
export declare function toPrune(list: unknown[], keep: number): DevRelease[];
export declare function staleDrafts(list: unknown[], version: string): { tag: string; parsed: [number, number, number, number] }[];
export declare function readReleases(repo: string): unknown[];
