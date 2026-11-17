export declare const TAG_PREFIX: string;
export declare function parse(v: unknown): [number, number, number] | null;
export declare function cmp(a: string, b: string): number;
export declare function releaseVersions(tags: string[]): string[];
export declare function highest(versions: string[]): string | null;
export declare function nextRelease(pkg: string, versions: string[]): string;
export declare function devBase(pkg: string, versions: string[]): string;
export declare function tagProblems(tag: string, pkg: string, tags: string[]): string[];
export declare function remoteTags(root: string): Map<string, string>;
export declare function versionAt(root: string, at: string): string;
export interface Plan { tag: string; version: string; since: string; reason: string }
export declare function plan(root: string, at: string, released: string[]): Plan;
export declare function check(root: string, tag: string, at: string): string;
