export interface HandedOver {
  id: number;
  tag: string;
  version: string;
  channel: 'dev' | 'stable';
  sha: string;
  created: string | null;
}
export declare function channelOf(version: string): 'dev' | 'stable' | null;
export declare function handedOver(list: unknown[]): HandedOver[];
export declare function waiting(list: unknown[]): HandedOver | null;
export declare function stale(list: unknown[], hours: number, now?: number): HandedOver[];
