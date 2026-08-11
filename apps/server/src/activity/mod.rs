#[allow(dead_code)] // Cancellation dispatch starts in Task 3; Task 2 establishes its private seam.
mod control;
mod controller;
mod model;
mod projection;
mod repository;
mod routing;
mod rpc;

pub(crate) use control::*;
pub use controller::*;
pub use model::*;
pub use projection::*;
pub use repository::*;
pub use routing::*;
pub use rpc::*;
