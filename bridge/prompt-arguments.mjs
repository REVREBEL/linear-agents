// Stateless Linear prompt extraction and CLI argument formatting.
// Keep these utilities independent of server bootstrap and process state.
export function extractAgentSessionId(job) {
  const original = job?.payload?.original ?? {};

  return firstString([
    job?.agentSessionId,
    job?.payload?.data?.agentSessionId,
    original?.data?.id,
    original?.agentSession?.id,
    original?.data?.agentSession?.id,
    original?.agentSessionId,
    original?.data?.agentSessionId,
  ]);
}

export function extractDirectTask(prompt) {
  if (!prompt) return undefined;
  // Linear's promptContext already contains the issue's instruction. For
  // created issue sessions, discard generated project summaries, synced
  // comment banners, agent guidance, and redundant wrapper text. Do not
  // filter the issue description itself: its safety/scope rules are task data.
  const issue = prompt.match(/<issue\b[^>]*identifier="([^"]+)"[^>]*>([\s\S]*?)<\/issue>/);
  if (!issue) return prompt;
  const title = issue[2].match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
  const description = issue[2].match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim();
  if (!title || !description) return prompt;
  const request = prompt.match(/<user-request>([\s\S]*?)<\/user-request>/)?.[1]?.trim();
  const isGenericRequest = request && /^Work on \[?[A-Z]+-\d+/i.test(request);
  return [
    `Issue: ${issue[1]}`,
    `Title: ${title}`,
    "",
    description,
    ...(request && !isGenericRequest ? ["", "Request:", request] : []),
  ].join("\n");
}

export function extractPromptContext(job) {
  return firstString([
    job?.payload?.data?.promptContext,
    job?.payload?.original?.data?.promptContext,
    job?.payload?.original?.promptContext,
    job?.payload?.original?.data?.agentSession?.promptContext,
  ]);
}

export function firstString(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

export function buildGenericArgs(template, prompt, jobFile, workspace) {
  const promptToken = "__AGENT_BRIDGE_PROMPT__";
  const jobFileToken = "__AGENT_BRIDGE_JOB_FILE__";
  const workspaceToken = "__AGENT_BRIDGE_WORKSPACE__";

  const templated = template
    .replaceAll("{{PROMPT}}", promptToken)
    .replaceAll("{{JOB_FILE}}", jobFileToken)
    .replaceAll("{{WORKSPACE}}", workspaceToken);

  return shellLikeSplit(templated).map((arg) =>
    arg
      .replaceAll(promptToken, prompt)
      .replaceAll(jobFileToken, jobFile)
      .replaceAll(workspaceToken, workspace),
  );
}

export function shellLikeSplit(value) {
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function maskArg(arg) {
  if (arg.length > 120) return `${arg.slice(0, 120)}...`;
  return arg;
}
