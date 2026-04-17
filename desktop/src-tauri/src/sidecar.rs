//! Sidecar supervisor for jellyclaw engine (T4-06).
//!
//! Spawns the jellyclaw binary as a child process, manages its lifecycle,
//! and ensures it terminates when the parent Tauri app exits.

use rand::Rng;
use regex::Regex;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

/// Errors that can occur during sidecar management.
#[derive(Error, Debug)]
pub enum SidecarError {
    #[error("Failed to spawn sidecar process: {0}")]
    SpawnFailed(String),

    #[error("Failed to read sidecar output: {0}")]
    ReadFailed(String),

    #[error("Sidecar did not start within timeout")]
    StartupTimeout,

    #[error("Failed to parse port from sidecar output")]
    PortParseFailed,

    #[error("Sidecar binary not found at: {0}")]
    BinaryNotFound(String),
}

/// Information about a running sidecar.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub token: String,
}

/// Sidecar supervisor that manages the jellyclaw engine child process.
pub struct SidecarSupervisor {
    child: Option<Child>,
    info: Option<SidecarInfo>,
}

impl SidecarSupervisor {
    /// Create a new supervisor (not yet spawned).
    pub fn new() -> Self {
        Self {
            child: None,
            info: None,
        }
    }

    /// Spawn the sidecar process.
    ///
    /// # Arguments
    /// * `resource_dir` - Path to the app's resource directory containing binaries/
    ///
    /// # Returns
    /// * `SidecarInfo` with port and auth token on success
    pub fn spawn(&mut self, resource_dir: &Path) -> Result<SidecarInfo, SidecarError> {
        // Generate random auth token (32 bytes, hex encoded = 64 chars)
        let token: String = {
            let mut rng = rand::thread_rng();
            let bytes: [u8; 32] = rng.gen();
            bytes.iter().map(|b| format!("{:02x}", b)).collect()
        };

        // Find the binary
        let binary_path = self.find_binary(resource_dir)?;
        info!(?binary_path, "Found jellyclaw binary");

        // Spawn the process
        let mut child = Command::new(&binary_path)
            .args(["serve", "--port", "0", "--token-env", "JELLYCLAW_AUTH_TOKEN"])
            .env("JELLYCLAW_AUTH_TOKEN", &token)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SidecarError::SpawnFailed(e.to_string()))?;

        // Read stderr to find the port
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SidecarError::ReadFailed("No stderr handle".to_string()))?;

        let port = self.wait_for_port(stderr)?;
        info!(port, "Sidecar started successfully");

        let info = SidecarInfo {
            port,
            token: token.clone(),
        };

        self.child = Some(child);
        self.info = Some(info.clone());

        Ok(info)
    }

    /// Find the jellyclaw binary in the resource directory.
    fn find_binary(&self, resource_dir: &Path) -> Result<std::path::PathBuf, SidecarError> {
        // Try architecture-specific names first
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        };

        let candidates = [
            resource_dir.join(format!("binaries/jellyclaw-{}", arch)),
            resource_dir.join("binaries/jellyclaw-universal"),
            resource_dir.join("binaries/jellyclaw"),
            // Tauri appends target triple
            resource_dir.join("binaries/jellyclaw-universal-apple-darwin"),
            resource_dir.join("binaries/jellyclaw-aarch64-apple-darwin"),
            resource_dir.join("binaries/jellyclaw-x86_64-apple-darwin"),
        ];

        for candidate in &candidates {
            debug!(?candidate, "Checking for binary");
            if candidate.exists() && candidate.is_file() {
                return Ok(candidate.clone());
            }
        }

        Err(SidecarError::BinaryNotFound(format!(
            "Tried: {:?}",
            candidates
        )))
    }

    /// Wait for the sidecar to output its listening port.
    fn wait_for_port(&self, stderr: std::process::ChildStderr) -> Result<u16, SidecarError> {
        let reader = BufReader::new(stderr);
        let port_regex =
            Regex::new(r#"listening on http://127\.0\.0\.1:(\d+)"#).expect("Invalid regex");

        // Give it 30 seconds to start
        let timeout = Duration::from_secs(30);
        let start = std::time::Instant::now();

        for line in reader.lines() {
            if start.elapsed() > timeout {
                return Err(SidecarError::StartupTimeout);
            }

            let line = line.map_err(|e| SidecarError::ReadFailed(e.to_string()))?;
            debug!(line = %line, "Sidecar stderr");

            if let Some(caps) = port_regex.captures(&line) {
                if let Some(port_str) = caps.get(1) {
                    if let Ok(port) = port_str.as_str().parse::<u16>() {
                        return Ok(port);
                    }
                }
            }
        }

        Err(SidecarError::PortParseFailed)
    }

    /// Get the sidecar info if running.
    pub fn info(&self) -> Option<&SidecarInfo> {
        self.info.as_ref()
    }

    /// Check if the sidecar is running.
    pub fn is_running(&mut self) -> bool {
        if let Some(ref mut child) = self.child {
            match child.try_wait() {
                Ok(None) => true,  // Still running
                Ok(Some(_)) => false, // Exited
                Err(_) => false,
            }
        } else {
            false
        }
    }

    /// Gracefully shutdown the sidecar.
    ///
    /// Sends SIGTERM, waits 5 seconds, then SIGKILL if necessary.
    pub fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            info!("Shutting down sidecar...");

            // Try graceful shutdown first (SIGTERM on Unix)
            #[cfg(unix)]
            {
                // SAFETY: We're sending SIGTERM to our own child process.
                unsafe {
                    libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
                }
            }

            // Wait up to 5 seconds for graceful exit
            let timeout = Duration::from_secs(5);
            let start = std::time::Instant::now();

            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        info!(?status, "Sidecar exited gracefully");
                        break;
                    }
                    Ok(None) => {
                        if start.elapsed() > timeout {
                            warn!("Sidecar did not exit gracefully, killing...");
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(e) => {
                        error!(?e, "Error checking sidecar status");
                        let _ = child.kill();
                        break;
                    }
                }
            }

            self.info = None;
        }
    }
}

impl Default for SidecarSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Thread-safe wrapper for the sidecar supervisor.
pub type SharedSupervisor = Arc<Mutex<SidecarSupervisor>>;

/// Create a new shared supervisor.
pub fn create_shared_supervisor() -> SharedSupervisor {
    Arc::new(Mutex::new(SidecarSupervisor::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_generation() {
        let mut rng = rand::thread_rng();
        let bytes: [u8; 32] = rng.gen();
        let token: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(token.len(), 64);
    }
}
