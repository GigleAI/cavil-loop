export declare function devVersion(release: string, count: number): string;
export interface Versions {
  files: { pkg: string; conf: string; cargo: string };
  text: { pkg: string; conf: string; cargo: string };
  pkg: string;
  conf: string;
  cargo: string | null;
}
export declare function readVersions(root: string): Versions;
export declare function commitCount(root: string): number;
export declare function stamp(root: string, o?: { write?: boolean; count?: number }): string;
