pub(crate) mod activity;
pub mod model;
pub mod runtime;
pub(crate) mod sse;

#[doc(hidden)]
pub use activity::{
    OpenCodeActivityFixtureAdapter, OpenCodeActivityOutput, OpenCodeActivityStateCounts,
};
#[cfg_attr(test, allow(unused_imports))]
pub use model::{
    OpenCodeInventorySnapshot, OpenCodeProviderModel, build_inventory_snapshot,
    merge_assistant_text, parse_model_slug,
};
#[cfg_attr(test, allow(unused_imports))]
pub use runtime::{
    OpenCodeRuntimeEvent, OpenCodeRuntimeEventStableView, OpenCodeSessionRuntime,
    OpenCodeSessionSnapshot,
};
