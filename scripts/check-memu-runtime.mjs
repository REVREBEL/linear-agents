#!/usr/bin/env node
// Operator-triggered, read-only host readiness check. Never prints credentials.
import { diagnoseMemuRuntime } from "../memory/memu-runtime-diagnostic.mjs";

const report = await diagnoseMemuRuntime();
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!report.configPrivate || !report.cliExecutable || !report.databaseConnected)
  process.exitCode = 1;
