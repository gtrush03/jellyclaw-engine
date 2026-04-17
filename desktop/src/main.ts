/**
 * Jellyclaw Desktop frontend entry point (T4-06).
 */

import { getSidecarInfo, openEventStream, type SidecarInfo } from "./lib/sidecar.js";

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------

const statusEl = document.getElementById("status") as HTMLDivElement;
const connectBtn = document.getElementById("connect") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sidecarInfo: SidecarInfo | null = null;
let eventController: AbortController | null = null;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(text: string, state: "pending" | "connected" | "error" = "pending") {
  statusEl.textContent = text;
  statusEl.className = `status ${state}`;
}

// ---------------------------------------------------------------------------
// Sidecar connection
// ---------------------------------------------------------------------------

async function connectToSidecar() {
  try {
    setStatus("Connecting to engine...");
    connectBtn.disabled = true;

    // Get sidecar info (spawns if not running)
    sidecarInfo = await getSidecarInfo();
    setStatus(`Connected on port ${sidecarInfo.port}`, "connected");

    // Open event stream
    eventController = await openEventStream(sidecarInfo, {
      path: "/events",
      onMessage: (event) => {
        console.log("Event:", event.data);
      },
      onError: (error) => {
        console.error("Event stream error:", error);
        setStatus(`Stream error: ${error.message}`, "error");
      },
      onOpen: () => {
        console.log("Event stream opened");
      },
    });

    connectBtn.textContent = "Disconnect";
    connectBtn.disabled = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Connection failed: ${message}`, "error");
    connectBtn.disabled = false;
  }
}

function disconnect() {
  if (eventController) {
    eventController.abort();
    eventController = null;
  }
  sidecarInfo = null;
  setStatus("Disconnected");
  connectBtn.textContent = "Connect to Engine";
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

connectBtn.addEventListener("click", () => {
  if (sidecarInfo) {
    disconnect();
  } else {
    connectToSidecar();
  }
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

async function init() {
  // Check if we're in Tauri
  if (typeof window !== "undefined" && "__TAURI__" in window) {
    setStatus("Ready to connect");
    connectBtn.disabled = false;

    // Auto-connect on startup
    await connectToSidecar();
  } else {
    setStatus("Not running in Tauri environment", "error");
  }
}

init();
