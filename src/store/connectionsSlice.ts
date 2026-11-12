import { translate } from "../i18n";
import { api } from "../lib/api";
import { publicConnectError } from "../lib/connectError";
import type { ConnectionConfig } from "../types";
import type { AppSlice } from "./appTypes";
import { connKey } from "./stateKeys";
import { connectionNode } from "./treeModel";
import { applyConnOrder, loadConnOrder } from "./treePreferences";
const sessionPasswords = new Map<string, string>();
/** Latest restored-tab attempt per connection. An older attempt must not connect after the tab was left. */
const restoreEpoch = new Map<string, number>();
type ConnectionsSlice = AppSlice<
  | "connections"
  | "meta"
  | "databases"
  | "autocommit"
  | "connecting"
  | "restoreNotice"
  | "dialogOpen"
  | "openDialog"
  | "closeDialog"
  | "refreshConnections"
  | "deleteConnection"
  | "connect"
  | "openRestoredConnection"
  | "rememberSessionPassword"
  | "closePasswordPrompt"
  | "disconnect"
  | "setAutocommit"
  | "commitSession"
  | "rollbackSession"
>;

export const createConnectionsSlice: ConnectionsSlice = (set, get) => ({
    connections: [],
    meta: {},
    databases: {},
    autocommit: {},
    connecting: {},
    restoreNotice: {},
    dialogOpen: false,
    openDialog(editing) {
        set({ dialogOpen: true, dialogEditing: editing });
    },
    closeDialog() {
        set({ dialogOpen: false, dialogEditing: undefined });
    },
    async refreshConnections() {
        const connections = applyConnOrder(await api.listConnections(), loadConnOrder());
        for (const previous of get().connections) {
            const next = connections.find(c => c.id === previous.id);
            if (!next || ["kind", "host", "port", "username", "database", "sslMode"].some(key => previous[key as keyof ConnectionConfig] !== next[key as keyof ConnectionConfig]))
                sessionPasswords.delete(previous.id);
        }
        const nodes = { ...get().nodes };
        const rootKeys: string[] = [];
        for (const c of connections) {
            const key = connKey(c.id);
            rootKeys.push(key);
            if (!nodes[key])
                nodes[key] = connectionNode(c);
            else
                nodes[key] = { ...nodes[key], label: c.name };
        }
        set({ connections, nodes, rootKeys });
        // A tab that outlives its connection is stranded: it cannot connect and it
        // cannot close itself, so it sits on "connect and open" forever — and since
        // the workspace is persisted, restarting brings it right back. Clean up here
        // rather than in deleteConnection so a connection removed any other way is
        // covered too. Same rule treeSlice uses when a database or table is dropped:
        // close the object browsers, keep the SQL the user wrote in query tabs.
        const live = new Set(connections.map(c => c.id));
        for (const tab of get().tabs)
            if ((tab.kind === "table" || tab.kind === "database" || tab.kind === "routine") &&
                tab.connId && !live.has(tab.connId))
                get().closeTab(tab.id, true);
    },
    async deleteConnection(id) {
        await api.deleteConnection(id);
        sessionPasswords.delete(id);
        const nodes = { ...get().nodes };
        delete nodes[connKey(id)];
        const meta = { ...get().meta };
        delete meta[id];
        const catalogs = { ...get().catalogs };
        for (const key of Object.keys(catalogs)) {
            if (key.startsWith(`${id}\u0000`))
                delete catalogs[key];
        }
        set({ meta, catalogs });
        await get().refreshConnections();
        get().showToast({ kind: "info", text: translate(get().language, "connection.removed") });
    },
    async connect(id, password, source = "manual") {
        const config = get().connections.find((item) => item.id === id);
        if (!config) {
            // The connection was deleted. Returning silently makes the button in the
            // stranded-tab placeholder look dead — nothing happens, no explanation.
            const text = translate(get().language, "connection.missing");
            set((s) => ({ restoreNotice: { ...s.restoreNotice, [id]: text } }));
            if (source === "manual") get().showToast({ kind: "error", text });
            return;
        }
        const needsPassword = config.kind !== "sqlite";
        if (get().connecting[id])
            return;
        if (password != null)
            sessionPasswords.set(id, password);
        const sessionPassword = needsPassword ? (sessionPasswords.get(id) ?? null) : null;
        set((s) => {
            const restoreNotice = { ...s.restoreNotice };
            delete restoreNotice[id];
            return { connecting: { ...s.connecting, [id]: true }, restoreNotice };
        });
        try {
            const meta = await api.connect(id, sessionPassword);
            set((s) => {
                const restoreNotice = { ...s.restoreNotice };
                delete restoreNotice[id];
                return {
                    meta: { ...s.meta, [id]: meta },
                    autocommit: { ...s.autocommit, [id]: true },
                    restoreNotice,
                };
            });
            if (get().passwordPromptId === id) set({ passwordPromptId: undefined });
            // Auto-expand the connection root.
            const key = connKey(id);
            const node = get().nodes[key];
            if (node) {
                set((s) => ({
                    nodes: { ...s.nodes, [key]: { ...node, expanded: true } },
                }));
                await get().loadChildren(key);
            }
            void get().loadCatalog(id, meta.currentDatabase);
            if (meta.hasMultipleDatabases) {
                void api
                    .listDatabases(id)
                    .then((dbs) => set((s) => ({ databases: { ...s.databases, [id]: dbs } })))
                    .catch(() => { });
            }
            get().showToast({
                kind: meta.credentialWarning ? "warn" : "success",
                text: meta.credentialWarning ?? translate(get().language, "connection.success", {
                    version: meta.serverVersion || meta.kind,
                }),
            });
        }
        catch (e) {
            const raw = String(e);
            const text = publicConnectError(raw, sessionPasswords.get(id));
            if (needsPassword)
                sessionPasswords.delete(id);
            const rejected = raw.includes("CREDENTIAL_REJECTED");
            const required = raw.includes("CREDENTIAL_REQUIRED");
            const friendly = rejected
                ? translate(get().language, "workspace.savedSecretRejected")
                : required
                    ? translate(get().language, "workspace.noSavedSecret")
                    : text;
            set((s) => ({ restoreNotice: { ...s.restoreNotice, [id]: friendly } }));
            // A restored tab reports the reason on its own card. Asking for a password
            // is a separate, explicit click so the dialog does not cover the workspace.
            if (source === "restore") return;
            if (required || rejected) {
                set({ passwordPromptId: id });
                if (rejected) get().showToast({ kind: "warn", text: friendly });
                return;
            }
            get().showToast({ kind: "error", text: friendly });
            throw e;
        }
        finally {
            set((s) => ({ connecting: { ...s.connecting, [id]: false } }));
        }
    },
    async openRestoredConnection(id, stillActive = () => true) {
        if (get().meta[id] || get().connecting[id]) return;
        const epoch = (restoreEpoch.get(id) ?? 0) + 1;
        restoreEpoch.set(id, epoch);
        const mine = () => restoreEpoch.get(id) === epoch && stillActive();
        set((s) => {
            const restoreNotice = { ...s.restoreNotice };
            delete restoreNotice[id];
            return { restoreNotice };
        });
        let saved = false;
        try {
            saved = await api.hasSavedSecret(id);
        } catch (error) {
            if (!mine()) return;
            const text = publicConnectError(String(error));
            set((s) => ({ restoreNotice: { ...s.restoreNotice, [id]: text } }));
            return;
        }
        if (!mine() || get().meta[id] || get().connecting[id]) return;
        if (!get().connections.some((item) => item.id === id)) {
            set((s) => ({ restoreNotice: { ...s.restoreNotice, [id]: translate(get().language, "connection.missing") } }));
            return;
        }
        if (!saved) {
            set((s) => ({ restoreNotice: { ...s.restoreNotice, [id]: translate(get().language, "workspace.noSavedSecret") } }));
            return;
        }
        await get().connect(id, null, "restore");
    },
    rememberSessionPassword(id, password) {
        sessionPasswords.set(id, password);
    },
    closePasswordPrompt() {
        set({ passwordPromptId: undefined });
    },
    async disconnect(id) {
        await api.disconnect(id);
        const meta = { ...get().meta };
        delete meta[id];
        const autocommit = { ...get().autocommit };
        delete autocommit[id];
        const catalogs = { ...get().catalogs };
        for (const catalog of Object.keys(catalogs)) {
            if (catalog.startsWith(`${id}\u0000`))
                delete catalogs[catalog];
        }
        // Reset the connection node so its children reload next time.
        const key = connKey(id);
        const nodes = { ...get().nodes };
        // Drop all descendant nodes.
        for (const k of Object.keys(nodes)) {
            if (k.startsWith(key + "/"))
                delete nodes[k];
        }
        if (nodes[key]) {
            nodes[key] = { ...nodes[key], childKeys: [], loaded: false, expanded: false };
        }
        set({ meta, autocommit, catalogs, nodes });
    },
    async setAutocommit(connId, enabled, database) {
        try {
            await api.setAutocommit(connId, enabled, database);
            set((s) => ({ autocommit: { ...s.autocommit, [connId]: enabled } }));
        } catch (e) {
            get().showToast({ kind: "error", text: String(e) });
        }
    },
    async commitSession(connId) {
        try {
            await api.commitSession(connId);
            get().showToast({ kind: "success", text: translate(get().language, "tx.committed") });
        }
        catch (e) {
            get().showToast({ kind: "error", text: String(e) });
        }
    },
    async rollbackSession(connId) {
        try {
            await api.rollbackSession(connId);
            get().showToast({ kind: "success", text: translate(get().language, "tx.rolledBack") });
        }
        catch (e) {
            get().showToast({ kind: "error", text: String(e) });
        }
    }
});
