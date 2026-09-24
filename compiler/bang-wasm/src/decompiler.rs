//! 暴力反编译器内核（vendored）
//!
//! 源码来自上游 `tools/decompiler`（A4-Tacks/mindustry_logic_bang_lang，GPL-3.0），
//! 原样搬入以便编进 wasm。改动仅有三处：
//!   1. 去掉 `#[global_allocator] MIMALLOC`（wasm 无 mimalloc）
//!   2. 去掉 CLI / 测试模块（`main.rs`、`quality/tests.rs`、`tests/`）
//!   3. 模块路径从 crate 根改为 `crate::decompiler::*`
//!
//! 对外的 wasm 入口见 crate 根的 [`crate::decompile_mlog`]。

use std::{iter::once, rc::Rc};
use rustc_hash::FxHashSet;

use tag_code::logic_parser::{Args, Var};

use crate::decompiler::{quality::Loss, supp::Cmp};

pub mod display_impl;
pub mod make;
pub mod quality;
pub mod supp;
pub mod clean;
pub mod walk;
pub mod patterns;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Jump<'a>(pub Label, pub Cmp<'a>);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Label(pub u16);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Reduce<'a> {
    Pure(Rc<[Args<'a>]>),
    Product(Vec<Reduce<'a>>),
    Label(Label),
    Jump(Jump<'a>),
    Break(Cmp<'a>),
    Skip(Cmp<'a>, Rc<[Reduce<'a>]>),
    DoWhile(Cmp<'a>, Rc<[Reduce<'a>]>),
    While(Cmp<'a>, Rc<[Reduce<'a>]>, Rc<[Reduce<'a>]>),
    IfElse(Cmp<'a>, Rc<[Reduce<'a>]>, Rc<[Reduce<'a>]>),
    GSwitch(Var, Rc<[(usize, Reduce<'a>)]>)
}
impl<'a> From<Jump<'a>> for Reduce<'a> {
    fn from(v: Jump<'a>) -> Self {
        Self::Jump(v)
    }
}

impl<'a> Reduce<'a> {
    pub fn as_label(&self) -> Option<&Label> {
        if let Self::Label(v) = self {
            Some(v)
        } else {
            None
        }
    }

    pub fn as_jump(&self) -> Option<&Jump<'a>> {
        if let Self::Jump(v) = self {
            Some(v)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone)]
pub struct Finder<'a> {
    pub current: FxHashSet<Rc<[Reduce<'a>]>>,
    pub losses_cache: Vec<f32>,
    pub limit: usize,
    pub guidance: bool,
}

impl<'a> Finder<'a> {
    pub fn iterate(&mut self) {
        let cases: Vec<_> = if self.guidance {
            self.current.drain().collect()
        } else {
            self.current.iter().cloned().collect()
        };

        cases.iter()
            .flat_map(|case| {
                (0..case.len()).map(|i| case.split_at(i))
            })
            .flat_map(|subcase| Self::patterns().iter()
                .map(move |&pattern| (subcase, pattern)))
            .for_each(|((unprocess, subcase), pattern)|
        {
            if let Some((prefix, reduced, suffix)) = pattern(self, subcase) {
                let new_case = unprocess.iter()
                    .cloned()
                    .chain(prefix)
                    .chain(once(reduced))
                    .chain(suffix.iter().cloned())
                    .collect();
                self.current.insert(new_case);
            }
        });

        if self.current.is_empty() {
            self.current.extend(cases);
        }
    }

    pub fn limite(&mut self) -> (f32, f32) {
        let losses = self.current.iter().map(|x| x.loss());
        self.losses_cache.clear();
        self.losses_cache.extend(losses);
        let losses = &mut self.losses_cache;

        let mut count = 0;
        losses.sort_by(|a, b| a.total_cmp(&b));
        let Some(&bound) = losses.get(self.limit) else {
            return (losses[0], losses.last().copied().unwrap())
        };
        self.current.retain(|elem| {
            let loss = elem.loss();
            let retain = match loss.total_cmp(&bound) {
                std::cmp::Ordering::Less => true,
                std::cmp::Ordering::Equal => count < self.limit,
                std::cmp::Ordering::Greater => false,
            };
            if retain {
                count += 1;
            }
            retain
        });

        (losses[0], bound)
    }

    pub fn current_reduces(&self) -> impl Iterator<Item = Reduce<'a>> + use<'a, '_> {
        self.current.iter()
            .map(|reduces| {
                reduces.iter().cloned().collect()
            })
    }

    pub fn current_cleaned(&self) -> impl Iterator<Item = Reduce<'a>> + use<'a, '_> {
        self.current_reduces()
            .map(|reduce| {
                let cleaned = clean::dedup_labels(reduce);
                let cleaned = clean::jump_to_break(cleaned);
                let cleaned = clean::unused_labels(cleaned);

                cleaned
            })
    }
}
