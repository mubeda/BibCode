//! Git Manager domain modules shared by the read, guard, and operation phases.

mod generation;
pub mod graph;
pub mod guards;
pub mod in_progress;
pub mod merge;
pub mod operations;
pub mod refs;
pub mod stash;
