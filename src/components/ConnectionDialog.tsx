import { useState } from "react";
import { nanoid } from "nanoid";
import { CheckCircle2, XCircle, Loader2, X, Info } from "lucide-react";
import { useApp } from "../store/appStore";
import { api } from "../lib/api";
import { DB_KINDS, COMPAT_PRESETS, type ConnectionConfig, type DbKind } from "../types";
import { useI18n } from "../hooks/useI18n";

const PRESET_COLORS = [
  "#7c9cff",
  "#4ec9b0",
  "#e5b567",
  "#c586c0",
  "#ff8fa3",
  "#56b6c2",
  "#7cc993",
  "#f78c6c",
];

function defaults(editing?: ConnectionConfig): ConnectionConfig {
  return (
    editing ?? {
      id: nanoid(10),
      name: "",
      kind: "mysql",
      host: "127.0.0.1",
      port: 3306,
      username: "root",
      database: "",
      sslMode: "prefer",
      color: null,
    }
  );
}

export default function ConnectionDialog() {
  const { t } = useI18n();
  const editing = useApp((s) => s.dialogEditing);
  const [cfg, setCfg] = useState<ConnectionConfig>(defaults(editing));
  const [password, setPassword] = useState("");
  const [test, setTest] = useState<{ s: "idle" | "run" | "ok" | "err"; m: string }>({
    s: "idle",
    m: "",
  });
  const [saving, setSaving] = useState(false);

  const isSqlite = cfg.kind === "sqlite";
  const isOracle = cfg.kind === "oracle";

  const patch = (p: Partial<ConnectionConfig>) => setCfg((c) => ({ ...c, ...p }));

  const setKind = (kind: DbKind) => {
    const dp = DB_KINDS.find((k) => k.value === kind)?.defaultPort ?? 0;
    patch({ kind, port: kind === "clickhouse" ? 8443 : dp, sslMode: kind === "clickhouse" ? "require" : "prefer", brand: null });
  };

  const close = () => useApp.getState().closeDialog();

  const doTest = async () => {
    setTest({ s: "run", m: "" });
    try {
      const version = await api.testConnection(cfg, password || null);
      setTest({ s: "ok", m: version });
    } catch (e) {
      setTest({ s: "err", m: String(e) });
    }
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const name = cfg.name.trim() || defaultName(cfg);
      const toSave = { ...cfg, name };
      await api.saveConnection(toSave);
      await useApp.getState().refreshConnections();
      if (!isSqlite && password) {
        useApp.getState().rememberSessionPassword(toSave.id, password);
      }
      useApp.getState().showToast({
        kind: "success",
        text: editing ? t("connection.updated") : t("connection.saved"),
      });
      close();
    } catch (e) {
      useApp.getState().showToast({ kind: "error", text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <div className="modal-head">
          <h3>{editing ? t("connection.edit") : t("connection.new")}</h3>
          <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={close}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label>{t("connection.engine")}</label>
            <div className="kind-tabs">
              {DB_KINDS.map((k) => (
                <button
                  key={k.value}
                  className={cfg.kind === k.value ? "on" : ""}
                  onClick={() => setKind(k.value)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-row">
            <label>兼容库</label>
            <select
              className="select"
              value={cfg.brand ?? ""}
              title="TiDB / OceanBase / KingBase 等走 MySQL / PostgreSQL 协议,选一个自动配好引擎和端口"
              onChange={(e) => {
                const p = COMPAT_PRESETS.find((x) => x.label === e.target.value);
                if (p) patch({ kind: p.kind, port: p.port, brand: p.label });
                else patch({ brand: null });
              }}
            >
              <option value="">选兼容数据库(自动配引擎/端口)…</option>
              {COMPAT_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label} — {p.note}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label>{t("connection.name")}</label>
            <input
              className="input"
              placeholder={defaultName(cfg)}
              value={cfg.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="form-row">
            <label>{t("connection.color")}</label>
            <div className="color-swatches">
              <span
                className={`swatch none ${!cfg.color ? "on" : ""}`}
                title={t("connection.colorNone")}
                onClick={() => patch({ color: null })}
              >
                <X size={12} />
              </span>
              {PRESET_COLORS.map((c) => (
                <span
                  key={c}
                  className={`swatch ${cfg.color === c ? "on" : ""}`}
                  style={{ background: c }}
                  onClick={() => patch({ color: c })}
                />
              ))}
            </div>
          </div>

          {isOracle && (
            <>
              <div className="form-row">
                <label>{t("connection.oracleDriver")}</label>
                <div className="kind-tabs">
                  <button
                    className={!cfg.oracleThick ? "on" : ""}
                    onClick={() => patch({ oracleThick: false })}
                  >
                    {t("connection.oracleThin")}
                  </button>
                  <button
                    className={cfg.oracleThick ? "on" : ""}
                    onClick={() => patch({ oracleThick: true })}
                  >
                    {t("connection.oracleThick")}
                  </button>
                </div>
              </div>
              <div className="form-row">
                <div className="muted" style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5 }}>
                  <Info size={15} style={{ flex: "0 0 auto", marginTop: 1, color: "var(--accent)" }} />
                  <span>
                    {cfg.oracleThick ? t("connection.oracleThickHint") : t("connection.oraclePending")}
                  </span>
                </div>
              </div>
            </>
          )}

          {isSqlite ? (
            <div className="form-row">
              <label>{t("connection.sqlitePath")}</label>
              <input
                className="input"
                placeholder="/path/to/database.db"
                value={cfg.database}
                onChange={(e) => patch({ database: e.target.value })}
              />
            </div>
          ) : (
            <>
              <div className="form-row">
                <div className="form-grid">
                  <div>
                    <label>{t("connection.host")}</label>
                    <input
                      className="input"
                      value={cfg.host}
                      onChange={(e) => patch({ host: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>{t("connection.port")}</label>
                    <input
                      className="input"
                      type="number"
                      value={cfg.port || ""}
                      onChange={(e) => patch({ port: Number(e.target.value) })}
                    />
                  </div>
                </div>
              </div>

              <div className="form-row">
                <div className="form-grid">
                  <div>
                    <label>{t("connection.username")}</label>
                    <input
                      className="input"
                      value={cfg.username}
                      onChange={(e) => patch({ username: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>SSL</label>
                    <select
                      className="select"
                      value={cfg.kind === "clickhouse" ? (cfg.sslMode === "require" ? "require" : "disable") : cfg.sslMode ?? "prefer"}
                      onChange={(e) => patch({ sslMode: e.target.value, ...(cfg.kind === "clickhouse" && [8123, 8443].includes(cfg.port) ? { port: e.target.value === "require" ? 8443 : 8123 } : {}) })}
                    >
                      <option value="disable">{t("ssl.disable")}</option>
                      {cfg.kind !== "clickhouse" && <option value="prefer">{t("ssl.prefer")}</option>}
                      <option value="require">{t("ssl.require")}</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="form-row">
                <label>{t("connection.password")}</label>
                <input
                  className="input"
                  type="password"
                  placeholder={editing ? t("connection.passwordKeep") : ""}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <div className="muted" style={{ marginTop: 7, fontSize: 12, lineHeight: 1.5 }}>
                  {t("connection.sessionPasswordHelp")}
                </div>
              </div>

              <div className="form-row">
                <label>{isOracle ? t("connection.oracleService") : t("connection.database")}</label>
                <input
                  className="input"
                  placeholder={isOracle ? "ORCLPDB1" : t("connection.optional")}
                  value={cfg.database}
                  onChange={(e) => patch({ database: e.target.value })}
                />
              </div>

            </>
          )}
        </div>

        <div className="modal-foot">
          {test.s === "ok" && (
            <span className="test-result ok">
              <CheckCircle2 size={15} /> {test.m || t("connection.connected")}
            </span>
          )}
          {test.s === "err" && (
            <span className="test-result err" title={test.m}>
              <XCircle size={15} /> {truncate(test.m, 60)}
            </span>
          )}
          {test.s === "run" && (
            <span className="test-result">
              <Loader2 size={15} className="spin" /> {t("connection.testing")}
            </span>
          )}
          {test.s === "idle" && <span style={{ marginRight: "auto" }} />}

          <button className="btn" onClick={doTest} disabled={test.s === "run"}>
            {t("action.test")}
          </button>
          <button className="btn" onClick={close}>
            {t("action.cancel")}
          </button>
          <button className="btn primary" onClick={doSave} disabled={saving}>
            {saving ? <Loader2 size={15} className="spin" /> : null}
            {editing ? t("action.save") : t("action.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

function defaultName(cfg: ConnectionConfig): string {
  if (cfg.kind === "sqlite") {
    const base = cfg.database.split(/[/\\]/).pop() || "SQLite";
    return base;
  }
  return `${cfg.host || "localhost"}${cfg.database ? "/" + cfg.database : ""}`;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
