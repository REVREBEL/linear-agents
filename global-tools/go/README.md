# Go

Distinguish installed Go toolchain (GOROOT), workspace (GOPATH), module cache and build cache.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `GOPATH` | Go workspace |
| `GOBIN` | Installed Go command binaries |
| `GOMODCACHE` | Module cache |
| `GOCACHE` | Build cache |
| `GOROOT` | Go distribution, usually autodetected |
| `GOTOOLCHAIN` | Toolchain selection |
| `GOPROXY` | Module proxy |
| `GOSUMDB` | Checksum database |

## References

- https://pkg.go.dev/cmd/go

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
