export declare const REPO: string;
export declare const PLATFORMS: Record<string, string>;
export declare function packageName(version: string, arch: string): string;
export declare function downloadUrl(version: string, file: string): string;
export declare function configuredPubkey(confPath: string): string;
export declare function parsePubkey(b64: string): { id: string; key: Buffer } | null;
export declare function parseSignature(b64: string): { alg: string; id: string; sig: Buffer; trusted: string; global: Buffer } | null;
export declare function keyId(b64: string): string | null;
export declare function verifySignature(data: Buffer, sigB64: string, pubB64: string): { ok: true; trusted: string } | { ok: false; why: string };
export declare function signedVersion(trusted: string): string | null;
export interface Manifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}
export declare function build(o: { version: string; dir: string; pubkey: string; notes?: string; date?: Date }): { ok: true; manifest: Manifest } | { ok: false; errors: string[] };
