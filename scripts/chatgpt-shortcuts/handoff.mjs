#!/usr/bin/env node
// Backward-compatible entrypoint used by agent-bridge.mjs.
// The macOS-specific implementation now lives under scripts/macos.
import "../macos/chatgpt-shortcuts/handoff.mjs";
