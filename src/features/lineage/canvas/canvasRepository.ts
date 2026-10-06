import { storedRepository } from "../../../lib/storedRepository";
import { isCanvasList, type CanvasDoc } from "./canvasModel";

/** 链路画布存在本机。格式不对的整份不认(由 jsonStorage 保留原文并提示),不会悄悄丢图。 */
export const canvasRepository = storedRepository<CanvasDoc[]>(
  "sonde.lineageCanvases.v1", () => [], isCanvasList,
);
