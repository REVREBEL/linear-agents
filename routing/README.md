# Agent routing

`hosts/host-routing.mjs` owns trusted execution-host and project-scope selection. `ssh/ssh-dispatch.mjs` and `ssh/remote-trae-activity.mjs` own Mac transport and callback-capability validation. Prior flat `routing/*.mjs` paths re-export these exact functions.
