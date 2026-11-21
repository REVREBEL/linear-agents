// ABR-98 deterministic prompt readiness classifier, independent of poll rate.
// This detects bounded text patterns, not a PTY state or a hardcoded 500ms SLA.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CARRIAGE = /\r(?!\n)/g;
const RULES = Object.freeze([
  ['python', /(?:^|\n)(?:>>> |\.\.\. )$/],
  ['pdb', /(?:^|\n)\(Pdb\)\s*$/],
  ['mysql', /(?:^|\n)(?:mysql|MariaDB \[[^\]\n]{0,80}\])>\s*$/],
  ['shell', /(?:^|\n)(?:\[[^\]\n]{1,90}\]\s*)?[^\n]{0,90}[#$>]\s*$/],
]);
function tail(input) {
  return (typeof input === 'string' ? input : '')
    .slice(-1_024).replace(ANSI, '').replace(CARRIAGE, '\n');
}
export function analyzeProcessState({
  stdout = '', stderr = '', finished = false, exitCode = null,
  cancelled = false, timedOut = false,
} = {}) {
  if (timedOut) return Object.freeze({ status: 'timed_out', prompt: null });
  if (cancelled) return Object.freeze({ status: 'cancelled', prompt: null });
  if (finished) return Object.freeze({
    status: exitCode === 0 ? 'completed' : 'failed', prompt: null,
  });
  for (const stream of [tail(stderr), tail(stdout)]) {
    for (const [prompt, rule] of RULES) {
      if (rule.test(stream)) return Object.freeze({ status: 'waiting_input', prompt });
    }
  }
  return Object.freeze({ status: 'running', prompt: null });
}
