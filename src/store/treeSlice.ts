import { api } from "../lib/api";
import type { AppSlice, TreeNode } from "./appTypes";
import { connKey, dbKey, schemaKey } from "./stateKeys";
import { buildNamespaceChildren, columnNodes } from "./treeModel";
import { loadHidden, loadNodeOrder, orderChildKeys, persistConnOrder, persistHidden, persistNodeOrder } from "./treePreferences";
type TreeSlice = AppSlice<
  | "nodes"
  | "rootKeys"
  | "hiddenKeys"
  | "showHidden"
  | "nodeOrder"
  | "selectedKey"
  | "toggleNode"
  | "selectNode"
  | "setNodeHidden"
  | "toggleShowHidden"
  | "reorderConnections"
  | "reorderChild"
  | "loadChildren"
  | "afterObjectDrop"
  | "refreshNode"
>;

export const createTreeSlice: TreeSlice = (set, get) => ({
    nodes: {},
    rootKeys: [],
    hiddenKeys: loadHidden(),
    showHidden: false,
    nodeOrder: loadNodeOrder(),
    selectedKey: undefined,
    async toggleNode(key) {
        const node = get().nodes[key];
        if (!node || !node.hasChildren)
            return;
        const expanded = !node.expanded;
        set((s) => ({ nodes: { ...s.nodes, [key]: { ...node, expanded } } }));
        if (expanded && !node.loaded) {
            await get().loadChildren(key);
        }
    },
    selectNode(key) {
        set({ selectedKey: key });
    },
    setNodeHidden(key, hidden) {
        const current = new Set(get().hiddenKeys);
        if (hidden)
            current.add(key);
        else
            current.delete(key);
        const arr = [...current];
        try {
            persistHidden(arr);
        } catch (error) {
            get().showToast({ kind: "error", text: String(error) });
            return;
        }
        set({ hiddenKeys: arr });
    },
    toggleShowHidden() {
        set((s) => ({ showHidden: !s.showHidden }));
    },
    reorderConnections(fromId, toId) {
        if (fromId === toId)
            return;
        const conns = [...get().connections];
        const from = conns.findIndex((c) => c.id === fromId);
        const to = conns.findIndex((c) => c.id === toId);
        if (from < 0 || to < 0)
            return;
        const [moved] = conns.splice(from, 1);
        conns.splice(to, 0, moved);
        try {
            persistConnOrder(conns.map((c) => c.id));
        } catch (error) {
            get().showToast({ kind: "error", text: String(error) });
            return;
        }
        set({ connections: conns, rootKeys: conns.map((c) => connKey(c.id)) });
    },
    reorderChild(parentKey, fromKey, toKey) {
        if (fromKey === toKey)
            return;
        const parent = get().nodes[parentKey];
        if (!parent)
            return;
        const keys = [...parent.childKeys];
        const from = keys.indexOf(fromKey);
        const to = keys.indexOf(toKey);
        if (from < 0 || to < 0)
            return;
        const [moved] = keys.splice(from, 1);
        keys.splice(to, 0, moved);
        const nextOrder = { ...get().nodeOrder, [parentKey]: keys };
        try {
            persistNodeOrder(nextOrder);
        } catch (error) {
            get().showToast({ kind: "error", text: String(error) });
            return;
        }
        set((s) => ({
            nodeOrder: nextOrder,
            nodes: { ...s.nodes, [parentKey]: { ...s.nodes[parentKey], childKeys: keys } },
        }));
    },
    async loadChildren(key) {
        const node = get().nodes[key];
        if (!node || node.loaded || node.loading)
            return;
        set((s) => ({ nodes: { ...s.nodes, [key]: { ...node, loading: true } } }));
        try {
            const connId = node.connId;
            const meta = get().meta[connId];
            let newNodes: Record<string, TreeNode> = {};
            let childKeys: string[] = [];
            if (node.kind === "connection") {
                if (meta?.kind === "sqlite") {
                    const k = dbKey(connId, "main");
                    newNodes[k] = {
                        key: k,
                        kind: "database",
                        label: "main",
                        connId,
                        database: "main",
                        schema: "main",
                        childKeys: [],
                        hasChildren: true,
                        loaded: false,
                        loading: false,
                        expanded: true,
                    };
                    childKeys = [k];
                }
                else if (meta?.hasMultipleDatabases) {
                    const dbs = await api.listDatabases(connId);
                    for (const db of dbs) {
                        const k = dbKey(connId, db);
                        newNodes[k] = {
                            key: k,
                            kind: "database",
                            label: db,
                            connId,
                            database: db,
                            childKeys: [],
                            hasChildren: true,
                            loaded: false,
                            loading: false,
                            expanded: false,
                        };
                        childKeys.push(k);
                    }
                }
                else {
                    // Postgres: browse the connected database.
                    const db = meta?.currentDatabase || "";
                    const k = dbKey(connId, db);
                    newNodes[k] = {
                        key: k,
                        kind: "database",
                        label: db,
                        connId,
                        database: db,
                        childKeys: [],
                        hasChildren: true,
                        loaded: false,
                        loading: false,
                        expanded: true,
                    };
                    childKeys.push(k);
                }
            }
            else if (node.kind === "database") {
                const db = node.database!;
                if (meta?.hasSchemas) {
                    const schemas = await api.listSchemas(connId, db);
                    for (const s of schemas) {
                        const k = schemaKey(connId, db, s);
                        newNodes[k] = {
                            key: k,
                            kind: "schema",
                            label: s,
                            connId,
                            database: db,
                            schema: s,
                            childKeys: [],
                            hasChildren: true,
                            loaded: false,
                            loading: false,
                            expanded: s === "public",
                        };
                        childKeys.push(k);
                    }
                }
                else {
                    const namespaceSchema = meta?.kind === "sqlite" ? "main" : "";
                    const [tables, routines] = await Promise.all([
                        api.listTables(connId, db, namespaceSchema),
                        api.listRoutines(connId, db, namespaceSchema),
                    ]);
                    const built = buildNamespaceChildren(key, connId, db, namespaceSchema, tables, routines, get().language);
                    newNodes = built.nodes;
                    childKeys = built.childKeys;
                }
            }
            else if (node.kind === "schema") {
                const [tables, routines] = await Promise.all([
                    api.listTables(connId, node.database!, node.schema!),
                    api.listRoutines(connId, node.database!, node.schema!),
                ]);
                const built = buildNamespaceChildren(key, connId, node.database!, node.schema!, tables, routines, get().language);
                newNodes = built.nodes;
                childKeys = built.childKeys;
            }
            else if (node.kind === "table" || node.kind === "view") {
                const cols = await api.listColumns(connId, node.database ?? "", node.schema ?? "", node.table!);
                const built = columnNodes(key, connId, node.database ?? "", node.schema ?? "", node.table!, cols, get().language);
                newNodes = built.nodes;
                childKeys = built.childKeys;
            }
            set((s) => {
                const nodes = { ...s.nodes, ...newNodes };
                const orderedKeys = orderChildKeys(key, childKeys, s.nodeOrder);
                nodes[key] = { ...nodes[key], childKeys: orderedKeys, loaded: true, loading: false };
                // Auto-expand freshly created folders that opted in.
                for (const [k, n] of Object.entries(newNodes)) {
                    if (n.expanded && !n.loaded) {
                        // leave lazy ones collapsed-loaded; only pre-expanded folders are loaded already
                    }
                    nodes[k] = n;
                }
                return { nodes };
            });
            // Kick off loads for children that were created pre-expanded (schemas/dbs).
            for (const [k, n] of Object.entries(newNodes)) {
                if (n.expanded && !n.loaded) {
                    get().loadChildren(k);
                }
            }
        }
        catch (e) {
            get().showToast({ kind: "error", text: String(e) });
            set((s) => ({ nodes: { ...s.nodes, [key]: { ...s.nodes[key], loading: false } } }));
        }
    },
    async afterObjectDrop(node) {
        const droppedDatabase = node.kind === "database";
        const state = get();
        // Preserve query drafts; only object browsers for the deleted target are closed.
        for (const tab of state.tabs) {
            if (tab.connId !== node.connId || tab.database !== node.database) continue;
            const sameObject = droppedDatabase
                || tab.kind === "table" && tab.schema === (node.schema ?? "") && tab.table === (node.table ?? node.label)
                || tab.kind === "routine" && tab.schema === (node.schema ?? "") && tab.routineName === node.label && tab.routineKind === node.kind;
            if ((tab.kind === "table" || tab.kind === "database" || tab.kind === "routine") && sameObject)
                get().closeTab(tab.id, true);
        }
        const catalogs = { ...get().catalogs };
        for (const key of Object.keys(catalogs))
            if (key.startsWith(`${node.connId}\u0000`))
                delete catalogs[key];
        const meta = { ...get().meta };
        if (droppedDatabase && meta[node.connId]?.currentDatabase === node.database && ["mysql", "mariadb", "clickhouse"].includes(meta[node.connId].kind))
            meta[node.connId] = { ...meta[node.connId], currentDatabase: meta[node.connId].kind === "clickhouse" ? "system" : "" };
        set({ catalogs, meta });
        const parent = Object.values(get().nodes).find(n => n.childKeys.includes(node.key));
        const refreshKey = droppedDatabase ? connKey(node.connId) : parent?.key;
        if (refreshKey)
            await get().refreshNode(refreshKey);
    },
    async refreshNode(key) {
        const node = get().nodes[key];
        if (!node)
            return;
        if (node.kind === "folder") {
            const parentKey = key.slice(0, key.lastIndexOf("/f:"));
            await get().refreshNode(parentKey);
            return;
        }
        const nodes = { ...get().nodes };
        for (const k of Object.keys(nodes)) {
            if (k.startsWith(key + "/"))
                delete nodes[k];
        }
        nodes[key] = { ...node, childKeys: [], loaded: false, expanded: true };
        set({ nodes });
        await get().loadChildren(key);
        void get().loadCatalog(node.connId, node.database, true);
    }
});
