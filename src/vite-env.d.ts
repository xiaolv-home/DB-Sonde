/// <reference types="vite/client" />

/* 导出离线看板时内联用的两种模块,由 vite/exportAssets.ts 提供。 */

/** 按需构建的 ECharts(只含离线页面用得到的图表和组件),整段 IIFE 源码。 */
declare module "virtual:echarts-standalone" {
  const source: string;
  export default source;
}

/** `?inline-min`:把这个文件压缩一遍再当字符串拿进来。跟 `?raw` 一样是源码, 
 *  只是去掉了注释和空白 —— 仓库里的源码不变,只影响内联进 HTML 的那份。 */
declare module "*?inline-min" {
  const source: string;
  export default source;
}

/* gifenc 没带类型声明,这里只写画布导出动图用到的几个 */
declare module "gifenc" {
  export type Palette = number[][];
  export interface FrameOptions {
    palette?: Palette;
    delay?: number;
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette): Uint8Array;
}
