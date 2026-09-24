//! bang-wasm: mindustry_logic_bang_lang 的 WASM 绑定
//!
//! 复刻 src/main.rs 的模式分发逻辑，但以 `Result` 返回错误（wasm 中不可 exit），
//! 供 acode-plugin-bang 与 Web IDE 在浏览器中直接调用。
//!
//! 模式与 CLI 完全一致：c a A t T f F r C l i n L b p

use std::{borrow::Cow, cell::RefCell, mem, rc::Rc};

use display_source::{DisplaySource, DisplaySourceMeta};
use logic_lint::Source;
use parser::{
    lalrpop_util::{lexer::Token, ParseError},
    TopLevelParser,
};
use syntax::{CompileMeta, CompileMetaExtends, Error, Expand, Meta};
use tag_code::{
    logic_parser::{parser as tparser, ParseLines}, TagCodes,
};
use wasm_bindgen::prelude::*;

const MAX_INVALID_TOKEN_VIEW: usize = 5;

mod complete;

// ---------- 基础工具（复刻 main.rs，错误改 Result） ----------

type ParseResult<'a> = Result<Expand, ParseError<usize, Token<'a>, Error>>;

fn build_ast(src: &str) -> Result<Expand, String> {
    let parser = TopLevelParser::new();
    let mut meta = Meta::new();
    parser
        .parse(&mut meta, src)
        .map_err(|e| parser::format_parse_err::<MAX_INVALID_TOKEN_VIEW>(e, src))
}

pub(crate) struct CompileMetaExtender {
    source: Rc<String>,
    display_meta: RefCell<DisplaySourceMeta>,
}

impl CompileMetaExtender {
    pub(crate) fn new(source: Rc<String>) -> Self {
        Self {
            source,
            display_meta: DisplaySourceMeta::new().into(),
        }
    }
}

impl CompileMetaExtends for CompileMetaExtender {
    fn source_location(&self, index: usize) -> [syntax::Location; 2] {
        let (line, col) = line_column::line_column(&self.source, index);
        [line as syntax::Location, col as syntax::Location]
    }
    fn display_value(&self, value: &syntax::Value) -> Cow<'_, str> {
        let meta = &mut *self.display_meta.borrow_mut();
        meta.to_default();
        value.display_source_and_get(meta).to_owned().into()
    }
    fn display_binds(&self, value: syntax::BindsDisplayer<'_>) -> Cow<'_, str> {
        let meta = &mut *self.display_meta.borrow_mut();
        meta.to_default();
        value.display_source_and_get(meta).to_owned().into()
    }
}

fn compile_ast(ast: Expand, src: String) -> Result<CompileMeta, String> {
    let mut meta = CompileMeta::new();
    let src = Rc::new(src);
    meta.set_extender(Box::new(CompileMetaExtender::new(src.clone())));
    meta.set_source(src);
    Ok(meta.compile_res_self(ast))
}

fn display_ast(ast: &Expand) -> String {
    let mut meta = Default::default();
    ast.display_source(&mut meta);
    let _ = meta.pop_lf();
    meta.buffer().into()
}

fn logic_parse(src: &str) -> Result<ParseLines<'_>, String> {
    tparser::lines(src).map_err(|e| {
        format!(
            "ParseLogicCode {}:{} expected {}",
            e.location.line, e.location.column, e.expected
        )
    })
}

fn logic_to_tagcode(lines: ParseLines<'_>, src: &str) -> Result<TagCodes, String> {
    TagCodes::try_from(lines).map_err(|e| {
        let (line, column) = e.location(src);
        format!("ParseTagCode {line}:{column} {e}\n或许你可以使用`t`模式编译来详细查看")
    })
}

fn logic_src_to_tagcode(src: &str) -> Result<TagCodes, String> {
    let lines = logic_parse(src)?;
    logic_to_tagcode(lines, src)
}

fn build_tag_down(tag_codes: &mut TagCodes) -> Result<(), String> {
    tag_codes
        .build_tagdown()
        .map_err(|(line, tag)| format!("重复的标记: {tag:?} (line {line})"))
}

fn compile_tagcodes(mut tag_codes: TagCodes) -> Result<String, String> {
    let logic_lines = tag_codes
        .compile()
        .map_err(|(line, tag)| format!("编译标记码失败: {tag:?} (line {line})"))?;
    Ok(logic_lines.join("\n"))
}

fn format_lints(src: &str) -> String {
    let source = Source::from_str(src);
    let lints = source.lint();
    let mut out = format!("共 {} 条 lint 提示\n", lints.len());
    for lint in lints {
        // Lint 的字段为私有，Debug 输出含 lineno/arg_idx/信息，足够诊断面板定位
        out.push_str(&format!("{lint:?}\n"));
    }
    out
}

// ---------- 模式分发 ----------

fn run_mode(mode: char, src: String) -> Result<String, String> {
    match mode {
        'c' => {
            let ast = build_ast(&src)?;
            let mut meta = compile_ast(ast, src.clone())?;
            let logic_codes = mem::take(meta.parse_lines_mut());
            let mut tag_codes = logic_to_tagcode(logic_codes, &src)?;
            build_tag_down(&mut tag_codes)?;
            compile_tagcodes(tag_codes)
        }
        'a' => {
            let ast = build_ast(&src)?;
            Ok(format!("{ast:#?}"))
        }
        'A' => {
            let ast = build_ast(&src)?;
            Ok(display_ast(&ast))
        }
        't' => {
            let ast = build_ast(&src)?;
            let mut meta = compile_ast(ast, src.clone())?;
            let tag_codes = logic_to_tagcode(mem::take(meta.parse_lines_mut()), &src)?;
            Ok(tag_codes.to_string())
        }
        'T' => {
            let ast = build_ast(&src)?;
            let mut meta = compile_ast(ast, src.clone())?;
            let mut tag_codes = logic_to_tagcode(mem::take(meta.parse_lines_mut()), &src)?;
            build_tag_down(&mut tag_codes)?;
            Ok(tag_codes.to_string())
        }
        'f' => {
            let mut lines = logic_src_to_tagcode(&src)?;
            lines
                .build_tagdown()
                .map_err(|(line, tag)| format!("重复的标记: {tag:?} (line {line})"))?;
            lines.tag_up();
            Ok(lines.to_string())
        }
        'F' => {
            let mut lines = logic_src_to_tagcode(&src)?;
            lines
                .build_tagdown()
                .map_err(|(line, tag)| format!("重复的标记: {tag:?} (line {line})"))?;
            lines.tag_up();
            Ok(lines.to_string())
        }
        'r' => {
            let logic_lines = logic_parse(&src)?;
            let ast = Expand::try_from(logic_lines).map_err(|e| {
                let (line, col) = e.location(&src);
                format!("MdtLogicToBang {line}:{col} {}", e.value)
            })?;
            Ok(display_ast(&ast))
        }
        'C' => {
            let mut tag_codes = logic_src_to_tagcode(&src)?;
            build_tag_down(&mut tag_codes)?;
            compile_tagcodes(tag_codes)
        }
        'l' => {
            // 与 CLI 行为对齐：lint 结果走 stderr 且非致命，此处直通输出
            Ok(src)
        }
        'i' => {
            let mut logic_lines = logic_parse(&src)?;
            logic_lines.index_label_popup();
            Ok(format!("{logic_lines:#}"))
        }
        'n' => {
            let mut logic_lines = logic_parse(&src)?;
            logic_lines.for_each_inner_label_mut(|mut lab| {
                lab.to_mut().push_str("_RENAME");
            });
            Ok(format!("{logic_lines:#}"))
        }
        'L' => {
            let ast = build_ast(&src)?;
            let mut meta = compile_ast(ast, src.clone())?;
            meta.parse_lines_mut().index_label_popup();
            Ok(format!("{}", meta.parse_lines()))
        }
        'b' => {
            let lines = logic_parse(&src)?;
            let out = tag_code::expr_builder::build(lines.iter().map(|x| &**x));
            Ok(out.join("\n"))
        }
        'p' => {
            let lines = mini_paren::parser::lines(&src).map_err(|e| {
                format!(
                    "ParseParenCode {}:{} expected {}",
                    e.location.line, e.location.column, e.expected
                )
            })?;
            let mut state = mini_paren::State::default();
            state.process_lines(&lines);
            state.out.truncate(state.out.trim_end().len());
            Ok(state.out)
        }
        _ => Err(format!("mode {mode:?} no pattern")),
    }
}

// ---------- WASM 接口 ----------

/// 按模式串依次转换（与 CLI 的多模式串联一致，如 "cl"）
/// 成功返回输出文本；失败抛出 JS 异常（错误信息含位置与原因）
#[wasm_bindgen]
pub fn compile(source: &str, modes: &str) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let mut src = source.to_string();
    for mode in modes.chars() {
        src = run_mode(mode, src).map_err(|e| JsValue::from_str(&e))?;
    }
    Ok(src)
}

/// 绑定的上游 bang 编译器版本（升级上游时同步修改）
const UPSTREAM_VERSION: &str = "0.22.6";

/// 版本信息：上游编译器版本 + 本绑定壳版本
#[wasm_bindgen]
pub fn version() -> String {
    format!("{} (wasm binding {})", UPSTREAM_VERSION, env!("CARGO_PKG_VERSION"))
}

/// 独立 lint：返回报告文本，空串 = 无提示
#[wasm_bindgen]
pub fn lint(source: &str) -> String {
    console_error_panic_hook::set_once();
    format_lints(source)
}

pub(crate) fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 官方补全：按光标字节下标返回 JSON 数组
/// 每项：{"label","detail","insert_text","kind","snippet"}
#[wasm_bindgen]
pub fn complete(source: &str, byte_index: usize) -> String {
    complete::complete_source(source, byte_index)
}

/// 安全版编译：返回 JSON 字符串 {"ok":bool,"output":str,"error":str}
/// 不会抛 JS 异常，供诊断面板直接解析
#[wasm_bindgen]
pub fn try_compile(source: &str, modes: &str) -> String {
    console_error_panic_hook::set_once();
    let mut src = source.to_string();
    for mode in modes.chars() {
        match run_mode(mode, src) {
            Ok(next) => src = next,
            Err(e) => {
                return format!("{{\"ok\":false,\"output\":\"\",\"error\":\"{}\"}}", json_escape(&e));
            }
        }
    }
    format!("{{\"ok\":true,\"output\":\"{}\",\"error\":\"\"}}", json_escape(&src))
}
