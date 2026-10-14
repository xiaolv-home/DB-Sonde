//! 表 / 视图 / 字段元数据:SQL 和「一行结果 → 结构体」只写一份,thin 和 thick 两种驱动共用,
//! 各自只管把查询跑起来、把每行转成 `Vec<Option<String>>`。
//! 注释来自 ALL_TAB_COMMENTS / ALL_COL_COMMENTS(COMMENT ON TABLE / COLUMN 写进去的)。

use super::{esc, format_oracle_type};
use crate::models::{ColumnInfo, TableInfo};
use std::collections::HashSet;

pub type Row = [Option<String>];

pub fn tables_sql(owner: &str) -> String {
    let o = esc(owner);
    format!(
        "SELECT t.table_name, t.num_rows, c.comments FROM all_tables t \
         LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name \
         WHERE t.owner = '{o}' ORDER BY t.table_name"
    )
}

pub fn views_sql(owner: &str) -> String {
    let o = esc(owner);
    format!(
        "SELECT v.view_name, c.comments FROM all_views v \
         LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name \
         WHERE v.owner = '{o}' ORDER BY v.view_name"
    )
}

pub fn primary_key_sql(owner: &str, table: &str) -> String {
    let (o, tb) = (esc(owner), esc(table));
    format!(
        "SELECT cc.column_name FROM all_constraints c \
         JOIN all_cons_columns cc ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name \
         WHERE c.constraint_type = 'P' AND c.owner = '{o}' AND c.table_name = '{tb}'"
    )
}

pub fn columns_sql(owner: &str, table: &str) -> String {
    let (o, tb) = (esc(owner), esc(table));
    format!(
        "SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale, \
                c.nullable, c.column_id, m.comments \
         FROM all_tab_columns c \
         LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name \
           AND m.column_name = c.column_name \
         WHERE c.owner = '{o}' AND c.table_name = '{tb}' ORDER BY c.column_id"
    )
}

fn cell(row: &Row, i: usize) -> Option<String> {
    row.get(i).cloned().flatten()
}
/// 空串当没有注释
fn comment(row: &Row, i: usize) -> Option<String> {
    cell(row, i).filter(|s| !s.trim().is_empty())
}

pub fn table_from(row: &Row) -> Option<TableInfo> {
    Some(TableInfo {
        name: cell(row, 0)?,
        kind: "table".into(),
        engine: None,
        estimated_rows: cell(row, 1).and_then(|s| s.parse::<i64>().ok()),
        data_size: None,
        comment: comment(row, 2),
        collation: None,
    })
}

pub fn view_from(row: &Row) -> Option<TableInfo> {
    Some(TableInfo {
        name: cell(row, 0)?,
        kind: "view".into(),
        engine: None,
        estimated_rows: None,
        data_size: None,
        comment: comment(row, 1),
        collation: None,
    })
}

pub fn primary_keys(rows: &[Vec<Option<String>>]) -> HashSet<String> {
    rows.iter().filter_map(|r| cell(r, 0)).collect()
}

pub fn column_from(row: &Row, pks: &HashSet<String>) -> Option<ColumnInfo> {
    let name = cell(row, 0)?;
    let num = |i: usize| cell(row, i).and_then(|s| s.parse().ok());
    Some(ColumnInfo {
        is_primary_key: pks.contains(&name),
        data_type: format_oracle_type(&cell(row, 1).unwrap_or_default(), num(2), num(3), num(4)),
        nullable: cell(row, 5).map(|s| s.eq_ignore_ascii_case("Y")).unwrap_or(true),
        default_value: None,
        ordinal_position: num(6),
        auto_increment: false,
        generated: false,
        comment: comment(row, 7),
        name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(cells: &[Option<&str>]) -> Vec<Option<String>> {
        cells.iter().map(|c| c.map(str::to_string)).collect()
    }

    #[test]
    fn comments_are_read_and_blank_ones_dropped() {
        let t = table_from(&row(&[Some("QH_STORE"), Some("42"), Some("门店")])).unwrap();
        assert_eq!((t.name.as_str(), t.estimated_rows, t.comment.as_deref()), ("QH_STORE", Some(42), Some("门店")));
        assert_eq!(table_from(&row(&[Some("T"), None, Some("  ")])).unwrap().comment, None, "空注释当没有");
        assert_eq!(view_from(&row(&[Some("V"), Some("视图说明")])).unwrap().comment.as_deref(), Some("视图说明"));
        let pks = primary_keys(&[row(&[Some("STORE_ID")])]);
        let c = column_from(&row(&[Some("STORE_ID"), Some("NUMBER"), Some("22"), Some("10"), Some("0"), Some("N"), Some("1"), Some("门店ID,主键")]), &pks).unwrap();
        assert!(c.is_primary_key && !c.nullable);
        assert_eq!(c.comment.as_deref(), Some("门店ID,主键"));
        assert_eq!(c.ordinal_position, Some(1));
        assert!(column_from(&row(&[None]), &pks).is_none(), "没有列名的行跳过");
    }

    #[test]
    fn metadata_sql_joins_comments_and_escapes_names() {
        assert!(tables_sql("QH").contains("all_tab_comments"));
        assert!(views_sql("QH").contains("all_tab_comments"));
        assert!(columns_sql("QH", "T").contains("all_col_comments"));
        assert!(columns_sql("O'X", "T'Y").contains("'O''X'") && columns_sql("O'X", "T'Y").contains("'T''Y'"), "单引号要转义");
    }
}
