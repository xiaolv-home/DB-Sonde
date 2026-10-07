import { storedRepository } from "../../lib/storedRepository";
import { isMonitorList, type MonitorSource } from "./monitorModel";

/** 接进来的监控页存在本机;格式不对的整份不认(由 jsonStorage 保留原文并提示)。 */
export const monitorRepository = storedRepository<MonitorSource[]>("sonde.monitorSources.v1", () => [], isMonitorList);
