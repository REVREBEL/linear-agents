---
context:
  id: host.replace-with-root
  version: 1
  title: Replace with host-tooling root
  topics: [host, tooling, runtime]
  requires: []
  applies_to: ["**/*"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Host location: replace with real root

## Owns
Name the exact host-specific state, binaries, config, or toolchains owned by this location.

## Does not own
Explain which source-controlled repository owns definitions and which adjacent `/opt` directory owns related state.

## Structure and dependencies
Identify major subfolders and their role. Include environment variable NAMES, local commands, and links to neighboring READMEs. No secrets or private data.

## Runtime contract
Describe executable discovery, environment setup, filesystem permissions, activation, and how this location is consumed by the agent bridge.

## Verification
Include read-only commands to check version, binary path, and expected startup behavior.

## Update policy
Update this README in the same change as any behavioral, dependency, security, or deployment change in this location.
