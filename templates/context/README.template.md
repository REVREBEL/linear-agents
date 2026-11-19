---
context:
  id: repo.replace-with-domain
  version: 1
  title: Replace with folder responsibility
  topics: [replace-topic]
  requires: []
  applies_to: ["relative/folder/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Folder name — responsibility

## Owns
Define the code, state, or contract this directory is authoritative for.

## Does not own
State the ownership boundaries and which directory or service owns neighboring responsibilities.

## Architecture and execution flow
Describe the entrypoint, key modules, and control/data flow. Link to code with repository-relative paths.

## Contracts and configuration
Describe interfaces, schemas, config files, environment-variable *names* (never values), important defaults, and external dependencies. Use `context.requires` for cross-folder reference dependencies; do not duplicate their documentation.

## Operations and verification
List the commands that operate and test this folder, their expected outcomes, and common failure modes. Distinguish checked behavior from planned behavior.

## Change discipline
Update this README in the same PR when changing runtime behavior, external contracts, configuration semantics, security boundaries, dependency relationships, or deployment procedures. Adding a profile/data file with no behavior change is exempt. Update frontmatter topics/dependencies when relevant.

## References
Link to source contracts, schema definitions, local docs, or design decisions. Do not place credentials, tokens, or session payloads in documentation.
