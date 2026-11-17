# Cargo and rustup

Cargo download/config home and rustup toolchain home are independent of Rust project output.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `CARGO_HOME` | Cargo tools/config/cache root |
| `RUSTUP_HOME` | Rustup toolchain home |
| `CARGO_TARGET_DIR` | Project build artifacts |
| `RUSTUP_TOOLCHAIN` | Selected Rust toolchain |
| `CARGO_NET_OFFLINE` | Cargo offline mode |

## References

- https://doc.rust-lang.org/cargo/reference/environment-variables.html

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
