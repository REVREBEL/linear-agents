# Bridge configuration

`agent-host-resolver.mjs` is the canonical ordered host identity resolver. Runtime secrets, host environment variables and service identity remain owned by the main entrypoint. Do not create new secret/config files or widen host matching here.
