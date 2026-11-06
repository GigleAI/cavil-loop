export declare const REPO: string;
export declare const PLATFORMS: Record<string, string>;
export declare function packageName(version: string, arch: string): string;
export declare function downloadUrl(version: string, file: string): string;
export declare function keyId(b64: string): string | null;
export declare function signedVersion(b64: string): string | null;
export interface Manifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}
export declare function build(o: { version: string; dir: string; pubkey: string; notes?: string; date?: Date }): { ok: true; manifest: Manifest } | { ok: false; errors: string[] };
