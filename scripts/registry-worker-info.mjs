#!/usr/bin/env node
// Shell-safe Worker selection contract: no eval or executable shell statements.
import { requireWorker } from "./agent-worker-registry.mjs";
const id = process.argv[2];
try {
  const agent = requireWorker(id);
  const prefix = agent.worker.prefixEnv.replace(/_PREFIX$/, "");
  const credential = agent.linear.credentialPrefix;
  const fields = [agent.workerDir, prefix, credential];
  if (fields.some(s => typeof s !== "string" || /[\r\n\t]/.test(s)))
    throw new Error("Invalid registry shell output field");
  process.stdout.write(fields.join("\t") + "\n");
} catch(error) {
  console.error(error.message);
  process.exitCode = 2;
}
