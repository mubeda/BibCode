//! Git Manager domain modules shared by the read, guard, and operation phases.

pub mod conflicts;
mod generation;
pub mod graph;
pub mod guards;
pub mod in_progress;
pub mod merge;
pub mod operations;
pub mod patch;
pub mod refs;
pub mod rewrite;
pub mod stash;
pub mod tags;
