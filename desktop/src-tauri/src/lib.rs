//! Jellyclaw Desktop Library (T4-06).
//!
//! Re-exports for testing and library usage.

pub mod sidecar;

pub use sidecar::{
    create_shared_supervisor, SharedSupervisor, SidecarError, SidecarInfo, SidecarSupervisor,
};
