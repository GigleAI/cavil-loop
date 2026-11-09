// Types for scripts/icon.mjs (plain JS so it runs with bare `node` on the CI runner).
export interface Image { width: number; height: number; channels: 3 | 4; data: Uint8Array }
export const BUILD_DIR: string;
export const SOURCE_PNG: string;
export const ICON_PNG: string;
export const SRC_RECT: { left: number; top: number; right: number; bottom: number; radius: number };
export const CANVAS: number;
export const BODY: number;
export const SAME_ICON_MAX_DISTANCE: number;
export function decodePng(buf: Buffer): Image;
export function encodePng(img: { width: number; height: number; data: Uint8Array }): Buffer;
export function insideSource(x: number, y: number, r?: typeof SRC_RECT): boolean;
export interface BodyLayout { width: number; height: number; body: number; sub?: number }
export function bodyBox(r?: typeof SRC_RECT, layout?: Partial<BodyLayout>): { scale: number; x: number; y: number; w: number; h: number };
export function renderIcon(src: Image): Image;
export function renderBody(src: Image, layout: BodyLayout): Image;
export const DOCS_LOGO_DIR: string;
export const LOGO_PNG: string;
export const SOCIAL_PNG: string;
export const LOGO: Required<BodyLayout>;
export const SOCIAL: Required<BodyLayout>;
export const SOCIAL_BG: [number, number, number];
export function flatten(img: Image, rgb: [number, number, number]): Image;
export function renderLogo(src: Image): Image;
export function renderSocial(src: Image): Image;
export function thumbnail(img: Image, n?: number): Float64Array;
export function imageDistance(a: Image, b: Image): number;
export function readIcns(buf: Buffer): { type: string; data: Buffer }[];
export function largestIcnsPng(buf: Buffer): { type: string; img: Image };
export function plistIconFile(xml: string): string;
export function checkApp(appPath: string, expectedPng: string): { icon: string; entry: string; size: string; distance: number; ok: boolean; img: Image };
