/* 数据集编辑器取元数据的几个 hook:库列表、表列表、表的列(按「连接+库」缓存)。 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

export interface TableItem { name: string; comment?: string }

export function useDatabases(connId: string): string[] {
  const [databases, setDatabases] = useState<string[]>([]);
  useEffect(() => {
    if (!connId) { setDatabases([]); return; }
    let live = true;
    void api.listDatabases(connId)
      .then((list) => { if (live) setDatabases(list); })
      .catch(() => { if (live) setDatabases([]); });
    return () => { live = false; };
  }, [connId]);
  return databases;
}

/** null = 还在读 */
export function useTables(connId: string, database: string | undefined): TableItem[] | null {
  const [tables, setTables] = useState<TableItem[] | null>(null);
  useEffect(() => {
    if (!connId) { setTables([]); return; }
    setTables(null);
    let live = true;
    void api.listTables(connId, database ?? "", "")
      .then((list) => { if (live) setTables(list.map((t) => ({ name: t.name, comment: t.comment ?? undefined }))); })
      .catch(() => { if (live) setTables([]); });
    return () => { live = false; };
  }, [connId, database]);
  return tables;
}

/**
 * 表的列。关联要用,自动推断也要用,所以按「连接+库+表」缓存在一处。
 *
 * load 返回列本身,而不只是塞进缓存:推断关联字段就发生在选中表的那一刻,那时
 * setState 还没回来,读缓存只会读到空的 —— 于是「自动推断」什么都推不出来。
 */
export function useTableColumns(connId: string, database: string | undefined) {
  const [cache, setCache] = useState<Record<string, string[]>>({});
  const cacheRef = useRef<Record<string, string[]>>({});
  const inFlight = useRef<Record<string, Promise<string[]>>>({});

  useEffect(() => { cacheRef.current = {}; inFlight.current = {}; setCache({}); }, [connId, database]);

  const load = (table: string): Promise<string[]> => {
    if (!connId || !table) return Promise.resolve([]);
    const known = cacheRef.current[table];
    if (known) return Promise.resolve(known);
    const running = inFlight.current[table];
    if (running) return running;
    const work = api.listColumns(connId, database ?? "", "", table)
      .then((list) => list.map((c) => c.name))
      .catch(() => [] as string[])
      .then((names) => {
        cacheRef.current = { ...cacheRef.current, [table]: names };
        setCache(cacheRef.current);
        delete inFlight.current[table];
        return names;
      });
    inFlight.current[table] = work;
    return work;
  };
  return { columns: cache, load };
}
