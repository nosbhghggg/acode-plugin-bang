//! 官方代码补全算法移植（源自上游 tools/bangls，GPL-3.0）
//!
//! 流程与官方 LSP 完全一致：
//!   1. 在光标处插入标记后解析（三个候选占位符，取第一个能解析成功的）
//!   2. 定位光标语义位置（行首 / 绑定名 / 绑定器 / 其它）
//!   3. emulate 出当前作用域可见的变量集合（complete_filter 过滤）
//!   4. 生成补全项（含 use_args 时的 `Var! $0;` / `Var[$0]` 片段）

use std::{ops::ControlFlow, rc::Rc};

use itertools::Itertools;
use linked_hash_map::LinkedHashMap;
use syntax::{
    walk::{self, Node},
    Compile, CompileMeta, ConstKey, Emulate, EmulateConfig, EmulateInfo,
    Expand, LogicLine, Value, ValueBind, ValueBindRef, ValueBindRefTarget, Var, LSP_DEBUG,
};
use var_utils::AsVarType;

use crate::CompileMetaExtender;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurLocation {
    LineFirst,
    Binder,
    BindName { first: bool },
    Other,
}

/// 判定光标所处的语义位置（移植自 bangls::cur_location）
pub fn cur_location(top: &Expand) -> CurLocation {
    let mut location = CurLocation::Other;
    let pred = |s: &Var| s.ends_with(LSP_DEBUG);
    let _ = walk::nodes(top.iter(), |node| {
        match node {
            Node::Value(Value::Var(var)) | Node::Key(ConstKey::Var(var)) if pred(var) => {
                return ControlFlow::Break(());
            }
            Node::Value(Value::ValueBindRef(ValueBindRef {
                bind_target: ValueBindRefTarget::NameBind(name),
                ..
            }))
            | Node::Value(Value::ValueBind(ValueBind(_, name)))
            | Node::Key(ConstKey::ValueBind(ValueBind(_, name)))
                if pred(name) =>
            {
                return ControlFlow::Break(location = CurLocation::BindName { first: false })
            }
            Node::Line(LogicLine::Other(args)) => {
                if let Some(first) = args.first() {
                    match first {
                        Value::Var(var) if pred(var) => {
                            return ControlFlow::Break(location = CurLocation::LineFirst)
                        }
                        Value::ValueBindRef(ValueBindRef {
                            bind_target: ValueBindRefTarget::NameBind(name),
                            ..
                        })
                        | Value::ValueBind(ValueBind(_, name)) if pred(name) => {
                            return ControlFlow::Break(location = CurLocation::BindName {
                                first: true,
                            })
                        }
                        _ => (),
                    }
                }
            }
            Node::Value(Value::ValueBindRef(ValueBindRef { value, .. }))
            | Node::Value(Value::ValueBind(ValueBind(value, _)))
            | Node::Key(ConstKey::ValueBind(ValueBind(value, _)))
                if value.as_var().is_some_and(pred) =>
            {
                return ControlFlow::Break(location = CurLocation::Binder)
            }
            _ => (),
        }

        ControlFlow::Continue(())
    });
    location
}

fn completion_name_filter(var: &str) -> bool {
    fn hide_special(s: &str) -> bool {
        s.chars().next().as_ref().is_none_or(char::is_ascii_digit)
            || s.starts_with("Builtin__")
    }

    if var.is_empty() {
        return false;
    }
    match var.as_var_type() {
        var_utils::VarType::Var(_) => (),
        var_utils::VarType::String(_) | var_utils::VarType::Number(_) => return false,
    }
    if var.strip_prefix("__").is_some_and(hide_special) {
        return false;
    }
    true
}

/// 补全项（序列化为 JSON 供插件消费）
struct Item {
    label: String,
    detail: String,
    insert_text: String,
    kind: &'static str,
    snippet: bool,
}

fn solid_snippets(cur_location: CurLocation) -> Vec<Item> {
    const SOLID: [(&str, &str, &str); 1] = [("const", "const($0)", "const $1 = ${2:($0)};")];
    SOLID
        .into_iter()
        .filter(move |_| !matches!(cur_location, CurLocation::BindName { .. }))
        .map(|(label, value, stmt)| {
            let snip = if cur_location == CurLocation::LineFirst {
                stmt
            } else {
                value
            };
            Item {
                label: label.into(),
                detail: snip.into(),
                insert_text: snip.into(),
                kind: "keyword",
                snippet: true,
            }
        })
        .collect()
}

fn generate_completes(infos: &[EmulateInfo], cur_location: CurLocation) -> Vec<Item> {
    let infos = infos.iter().filter_map(|it| it.exist_vars.as_ref());
    let full_count = infos.clone().count() as u32;
    let mut var_counter: LinkedHashMap<&Var, (u32, Vec<Emulate>, bool)> = LinkedHashMap::new();
    for info in infos {
        for (kind, var, use_args) in info {
            let (slot, kinds, use_args_slot) = var_counter.entry(var).or_default();
            *slot += 1;
            *use_args_slot |= *use_args;
            kinds.push(kind.clone());
        }
    }

    let mut items: Vec<Item> = var_counter
        .iter()
        .map(|(&var, &(count, ref kinds, use_args))| {
            let is_full_deps = count == full_count;

            let mut first_kind: Option<&Emulate> = None;
            let kind = kinds
                .iter()
                .inspect(|k| {
                    if first_kind.is_none() {
                        first_kind = Some(*k);
                    }
                })
                .map(|kind| match kind {
                    Emulate::Const => "constant".to_string(),
                    Emulate::Binder => "binder".to_string(),
                    Emulate::ConstBind(var) => format!("const bind to `{var}`"),
                    Emulate::NakedBind(var) => format!("naked bind to `{var}`"),
                })
                .unique()
                .join("\n    & ");

            let (label, detail) = if is_full_deps {
                (
                    var.to_string(),
                    format!("kind: {kind}\nfull deps ({count}/{full_count})"),
                )
            } else {
                (
                    format!("{var}?"),
                    format!("kind: {kind}\npartial deps ({count}/{full_count})"),
                )
            };

            let kind_str = match first_kind {
                Some(Emulate::Const) => "constant",
                Some(Emulate::Binder) => "variable",
                Some(Emulate::ConstBind(_)) => "method",
                Some(Emulate::NakedBind(_)) => "field",
                None => "text",
            };

            let insert_snippet = match (use_args, cur_location) {
                (true, CurLocation::LineFirst | CurLocation::BindName { first: true }) => {
                    format!("{var}! $0;")
                }
                (true, loc) if loc != CurLocation::LineFirst => format!("{var}[$0]"),
                _ => var.to_string(),
            };
            let snippet = insert_snippet != var.to_string();

            Item {
                label,
                detail,
                insert_text: insert_snippet,
                kind: kind_str,
                snippet,
            }
        })
        .chain(solid_snippets(cur_location))
        .collect();

    items.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    items
}

fn emulate_for_complete(
    top: Expand,
    src: String,
    cfg: EmulateConfig,
) -> Vec<EmulateInfo> {
    let source: Rc<String> = src.into();
    let mut meta = CompileMeta::with_source(source.clone());
    meta.emutale_config = Some(cfg);
    meta.set_extender(Box::new(CompileMetaExtender::new(source)));
    let _ = top.compile(&mut meta);
    meta.emulate_infos.take()
}

/// 主入口：按光标字节下标补全，返回 JSON 数组
pub fn complete_source(file: &str, byte_index: usize) -> String {
    if byte_index > file.len() || !file.is_char_boundary(byte_index) {
        return "[]".to_string();
    }

    let parser = parser::TopLevelParser::new();
    let placeholders = [
        format!("{LSP_DEBUG} "),
        format!("{LSP_DEBUG} __lsp_arg;"),
        format!("{LSP_DEBUG};"),
    ];

    for placeholder in &placeholders {
        let source = String::from_iter([&file[..byte_index], placeholder, &file[byte_index..]]);
        let Ok(top) = parser.parse(&mut syntax::Meta::new(), &source) else {
            continue;
        };
        let location = cur_location(&top);
        let infos = emulate_for_complete(
            top,
            source,
            EmulateConfig {
                complete_filter: Some(completion_name_filter),
                ..Default::default()
            },
        );
        let items = generate_completes(&infos, location);
        return items_to_json(&items);
    }

    "[]".to_string()
}

fn items_to_json(items: &[Item]) -> String {
    let mut out = String::from("[");
    for (i, it) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"label\":\"{}\",\"detail\":\"{}\",\"insert_text\":\"{}\",\"kind\":\"{}\",\"snippet\":{}}}",
            crate::json_escape(&it.label),
            crate::json_escape(&it.detail),
            crate::json_escape(&it.insert_text),
            it.kind,
            it.snippet,
        ));
    }
    out.push(']');
    out
}
