import { requireReadOnlyAnalysis } from "../../lib/databaseDialect";
import { useMetrics } from "../metrics/metricsStore";
import { useApp } from "../../store/appStore";
import { api } from "../../lib/api";
import { createQueryGate } from "../../lib/queryGate";
import { createDatasetQueryRuntime, type DatasetQueryPorts } from "./queryRuntime";
export { validateDatasetSql } from "./datasetSql";
export type { DatasetSqlErrorKey, DatasetQueryFilter } from "./datasetSql";

const gate = createQueryGate(3);
/** Preserve one transport concurrency budget across UI and independent analysis sessions. */
export const readQuery: DatasetQueryPorts["readQuery"] = (id, db, sql, rows, filters, timeout, signal) =>
  gate(() => { requireReadOnlyAnalysis(useApp.getState().connections.find(c => c.id === id)?.kind); return api.runReadOnlyQuery(id, db, sql, rows, filters, timeout); }, signal);

export function createQuerySession(readCatalog: DatasetQueryPorts["readCatalog"], dialectFor: DatasetQueryPorts["dialectFor"]) {
  return createDatasetQueryRuntime({ readCatalog, dialectFor, readQuery });
}
const shared = createQuerySession(() => useMetrics.getState().metrics,
  id => useApp.getState().connections.find(connection => connection.id === id)?.kind);
export const { executeDataset, clearQueryCache, primeQueryCache } = shared;
