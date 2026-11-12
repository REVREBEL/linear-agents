// Task-scoped development tools. These are Node-side operations, not prompt instructions.
// IMPORTANT: The runner must execute under an unprivileged OS account with no access
// to production secrets or services. The Git checkout must be disposable.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const PROTECTED = new Set([".git", ".env", ".dev.vars", ".env.linear-bridge", ".ssh", ".config", "node_modules", "linear-jobs", ".linear-agent"]);
function validatePath(value) {
  if (typeof value !== "string" || !value || value.length > 400 || value.includes("\\") ||
      value.includes("\0") || path.isAbsolute(value) || value.split("/").some(x => !x || x === ".." || PROTECTED.has(x))) {
    throw Error("Path outside approved source scope");
  }
  return value;
}
function within(root, p) { return p === root || p.startsWith(root + path.sep); }
export async function createDevOperations({ workspace, fsApi = fs, execute = exec }) {
  const root = await fsApi.realpath(workspace);
  if (!root.startsWith("/home/rebel/")) throw Error("Gemma development checkout must be inside /home/rebel/");
  const { stdout: top } = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 10000 });
  if (path.resolve(top.trim()) !== root) throw Error("Workspace must be repository root");
  const { stdout: branch } = await execute("git", ["branch", "--show-current"], { cwd: root, timeout: 10000 });
  if (!branch.trim() || ["main", "master"].includes(branch.trim())) throw Error("Gemma cannot work on a protected branch");
  async function target(relative, allowMissing = false) {
    const candidate = path.resolve(root, validatePath(relative));
    if (!within(root, candidate)) throw Error("Outside checkout");
    let current = candidate;
    while (current !== root) {
      const stat = await fsApi.lstat(current).catch(e => e.code === "ENOENT" && allowMissing ? null : Promise.reject(e));
      if (stat?.isSymbolicLink()) throw Error("Symlink paths forbidden");
      current = path.dirname(current);
    }
    return candidate;
  }
  return {
    root, branch: branch.trim(),
    async list(dir = "root") {
      const targetPath = dir === "root" ? root : await target(dir);
      const entries = await fsApi.readdir(targetPath, { withFileTypes: true });
      return entries.filter(e => !PROTECTED.has(e.name) && !e.isSymbolicLink()).slice(0, 180)
        .map(e => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
    },
    async read(file) {
      const p = await target(file);
      const stat = await fsApi.stat(p);
      if (!stat.isFile() || stat.size > 200000) throw Error("File too large or not regular");
      return (await fsApi.readFile(p, "utf8")).slice(0, 200000);
    },
    async write(file, content) {
      if (typeof content !== "string" || content.length > 300000) throw Error("Invalid content");
      const p = await target(file, true);
      await fsApi.mkdir(path.dirname(p), { recursive: true });
      await fsApi.writeFile(p, content, { flag: "w" });
      return "Written " + file;
    },
    async move(source, destination) {
      const a = await target(source), b = await target(destination, true);
      if (a === b || within(a, b) || within(b, a)) throw Error("Overlapping move");
      await fsApi.mkdir(path.dirname(b), { recursive: true });
      await fsApi.rename(a, b);
      return "Moved " + source + " to " + destination;
    },
    async remove(file) {
      const p = await target(file);
      await fsApi.rm(p, { recursive: true, force: false });
      return "Removed " + file;
    },
    async runTest(script) {
      if (!["typecheck", "test:reliability", "bridge:test", "lint"].includes(script)) throw Error("Test command not approved");
      const { stdout, stderr } = await execute("npm", ["run", script], { cwd: root, timeout: 180000, maxBuffer: 512000 });
      return (stdout + "\n" + stderr).slice(-12000);
    },
    async gitStatus() {
      const { stdout } = await execute("git", ["status", "--short"], { cwd: root, timeout: 10000 });
      return stdout.slice(0, 14000);
    },
    async gitDiff() {
      const { stdout } = await execute("git", ["diff", "--stat"], { cwd: root, timeout: 10000 });
      return stdout.slice(0, 14000);
    },
    async commit(message) {
      if (typeof message !== "string" || !/^.{8,120}$/.test(message) || /[\r\n]/.test(message)) throw Error("Invalid commit message");
      // Explicitly stage source changes in the disposable checkout. Never push or merge here.
      await execute("git", ["add", "-A", "--", "."], { cwd: root, timeout: 30000 });
      const { stdout } = await execute("git", ["commit", "-m", message], { cwd: root, timeout: 60000 });
      return stdout.slice(0, 3000);
    },
  };
}
export function makeGemmaDevTools(ops, sdk) {
  const { tool, z } = sdk;
  const wrap = (name, description, schema, fn) => tool({ name, description, inputSchema: z.object(schema), execute: fn });
  return [
    wrap("list_directory", "List directory under repository root. Use root for top level.", { directory: z.string() }, x => ops.list(x.directory)),
    wrap("read_file", "Read tracked source text file by relative path.", { file: z.string() }, x => ops.read(x.file)),
    wrap("write_file", "Create or replace source file by relative path.", { file: z.string(), content: z.string() }, x => ops.write(x.file, x.content)),
    wrap("move_path", "Move source file or directory by relative path.", { source: z.string(), destination: z.string() }, x => ops.move(x.source, x.destination)),
    wrap("delete_path", "Remove source file or directory in disposable checkout.", { file: z.string() }, x => ops.remove(x.file)),
    wrap("run_test", "Run one approved package script: typecheck, test:reliability, bridge:test, lint.", { script: z.string() }, x => ops.runTest(x.script)),
    wrap("git_status", "Read git status of current task branch.", {}, () => ops.gitStatus()),
    wrap("git_diff", "Read git diff summary.", {}, () => ops.gitDiff()),
    wrap("git_commit", "Commit changes on current task branch, without pushing.", { message: z.string() }, x => ops.commit(x.message)),
  ];
}
