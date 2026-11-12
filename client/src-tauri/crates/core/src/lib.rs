//! Back end of the Cavil Loop desktop client (GitHub#151): everything that
//! touches the GitHub credential. The window (TypeScript) never sees it.

pub mod api;
pub mod daemon;
pub mod daemon_connect;
pub mod device;
pub mod engine;
pub mod grant;
pub mod http;
pub mod platform;
pub mod release_image;
pub mod store;
pub mod update;
pub mod window_state;
pub mod zoom;

pub use engine::{Deps, Engine};
