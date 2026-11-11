// Convert the same development operations into OpenAI-compatible tool schemas
// for LiteLLM. No unrestricted shell, remote Git writes, or deployment controls.
export function makeLiteLLMDevelopmentTools(ops) {
  const string = { type: "string" };
  const spec = (name, description, properties, required, execute) => ({
    name, description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    execute,
  });
  return [
    spec("list_directory", "List repository directory (root for top level).", { directory: string }, ["directory"], x => ops.list(x.directory)),
    spec("read_file", "Read a repository source file by relative path.", { file: string }, ["file"], x => ops.read(x.file)),
    spec("write_file", "Write a repository source file.", { file: string, content: string }, ["file", "content"], x => ops.write(x.file, x.content)),
    spec("move_path", "Move source file or directory within task checkout.", { source: string, destination: string }, ["source", "destination"], x => ops.move(x.source, x.destination)),
    spec("delete_path", "Delete source file or directory within task checkout.", { file: string }, ["file"], x => ops.remove(x.file)),
    spec("run_test", "Run approved npm test or typecheck script.", { script: { type: "string", enum: ["typecheck", "test:reliability", "bridge:test", "lint"] } }, ["script"], x => ops.runTest(x.script)),
    spec("git_status", "Inspect Git working tree status.", {}, [], () => ops.gitStatus()),
    spec("git_diff", "Inspect Git changes summary.", {}, [], () => ops.gitDiff()),
    spec("git_commit", "Commit task-branch modifications; no push.", { message: string }, ["message"], x => ops.commit(x.message)),
  ];
}
