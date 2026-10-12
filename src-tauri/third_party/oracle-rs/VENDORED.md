# oracle-rs 0.1.7, vendored

Upstream: https://crates.io/crates/oracle-rs (MIT OR Apache-2.0), unmodified except
for `local-changes.patch` (two fixes, described below). Wired in through `[patch.crates-io]`
in `src-tauri/Cargo.toml`.

## Why

`send_marker` wrote the TNS packet's length field as 16-bit regardless of the
format negotiated at ACCEPT. On a large-SDU connection — which is what a modern
server gives you — the server read the RESET marker's length as `0x000b0000`
(720896) and waited for a packet that never came, then dropped the connection.

Markers are how Oracle announces a server-side SQL error, so this broke error
reporting completely: every ORA-00955 / ORA-00942 / ORA-00902 / ORA-01031 reached
the user as the crate's fallback string, "binding a temporary LOB to an INSERT
statement", and the connection was destroyed along the way. Verified against
python-oracledb in thin mode, which reports all of these correctly on the same
server; captured both drivers' TNS traffic to confirm the byte-level difference:

    python-oracledb   0000000b 0c 00 0000 010002   length = 11
    oracle-rs         000b0000 0c 00 0000 010002   length = 720896

With the patch, the same statements now surface ORA-00955, ORA-00902, ORA-00942,
ORA-00922 and ORA-01476, and the connection survives the error.

## Second change: leading comments (2026-10)

`Statement::parse` read the first word of the SQL to decide Query / DML / DDL /
PL/SQL without skipping comments, so `/* note */ SELECT …` or
`-- note\nSELECT …` was typed `Unknown` and executed with the wrong OALL8
options. Oracle 23ai/26ai rejects that as a malformed TTC packet
(`ORA-03137 [kpoal8Check-5] [32768] … [34912]` in the alert log), and after a few
of those the session is terminated (`ORA-03138`, then `I/O error: early eof` on
the client). `parse` now skips leading `--` and `/* */` comments first. Reproduced
and verified against Oracle Free 23 (gvenzl/oracle-free:23-slim-faststart).

## Dropping this vendored copy

Send the patch upstream. Once a release contains the fix, delete this directory
and the `[patch.crates-io]` section, and bump the `oracle-rs` version.
