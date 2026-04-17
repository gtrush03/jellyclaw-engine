//! Jellyclaw Desktop Application (T4-06).
//!
//! Tauri 2 desktop shell that spawns the jellyclaw engine as a sidecar
//! and provides IPC commands for the frontend to communicate with it.

// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use sidecar::{create_shared_supervisor, SharedSupervisor, SidecarInfo};
use std::sync::Arc;
use tauri::{Manager, RunEvent, State};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// Tauri command to get sidecar connection info.
///
/// Returns the port and auth token for the running sidecar.
/// If the sidecar is not yet running, this will spawn it.
#[tauri::command]
async fn get_sidecar_info(
    app: tauri::AppHandle,
    supervisor: State<'_, SharedSupervisor>,
) -> Result<SidecarInfo, String> {
    let mut guard = supervisor.lock().await;

    // Return existing info if sidecar is running
    if guard.is_running() {
        if let Some(info) = guard.info() {
            return Ok(info.clone());
        }
    }

    // Spawn the sidecar
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    info!(?resource_dir, "Spawning sidecar");

    guard
        .spawn(&resource_dir)
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))
}

/// Tauri command to check if sidecar is running.
#[tauri::command]
async fn is_sidecar_running(supervisor: State<'_, SharedSupervisor>) -> Result<bool, String> {
    let mut guard = supervisor.lock().await;
    Ok(guard.is_running())
}

/// Tauri command to restart the sidecar.
#[tauri::command]
async fn restart_sidecar(
    app: tauri::AppHandle,
    supervisor: State<'_, SharedSupervisor>,
) -> Result<SidecarInfo, String> {
    let mut guard = supervisor.lock().await;

    // Shutdown existing
    guard.shutdown();

    // Spawn new
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    guard
        .spawn(&resource_dir)
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))
}

/// Tauri command to gracefully shutdown the sidecar.
#[tauri::command]
async fn shutdown_sidecar(supervisor: State<'_, SharedSupervisor>) -> Result<(), String> {
    let mut guard = supervisor.lock().await;
    guard.shutdown();
    Ok(())
}

fn main() {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    info!("Starting Jellyclaw Desktop");

    // Create shared supervisor
    let supervisor = create_shared_supervisor();
    let supervisor_for_exit = Arc::clone(&supervisor);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(supervisor)
        .invoke_handler(tauri::generate_handler![
            get_sidecar_info,
            is_sidecar_running,
            restart_sidecar,
            shutdown_sidecar,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            // Handle exit to ensure sidecar is terminated
            if let RunEvent::ExitRequested { .. } = event {
                info!("Exit requested, shutting down sidecar...");
                // We need to block here to ensure cleanup happens
                let supervisor = Arc::clone(&supervisor_for_exit);
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Runtime::new().unwrap();
                    rt.block_on(async {
                        let mut guard = supervisor.lock().await;
                        guard.shutdown();
                    });
                })
                .join()
                .ok();
            }
        });
}

// Library entry point for tests
pub use sidecar::{SidecarError, SidecarSupervisor};
