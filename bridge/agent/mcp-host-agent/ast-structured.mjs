// ABR-98 — scoped TypeScript/JavaScript structural reads and dry-run edits.
// A production mutation requires an independently approved atomic writer.
// No sed/regex replacement, path-following writes, or unreviewed AST plugins.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { openScopedFile, readBoundedFile } from './safe-read.mjs';

import { parse } from '@babel/parser';

const KINDS = Object.freeze({
  functionDeclaration: 'FunctionDeclaration',
  classDeclaration: 'ClassDeclaration',
  interfaceDeclaration: 'TSInterfaceDeclaration',
  variableDeclaration: 'VariableDeclarator',
  methodDeclaration: 'ClassMethod',
  importDeclaration: 'ImportDeclaration',
  callExpression: 'CallExpression',
  typeAliasDeclaration: 'TSTypeAliasDeclaration',
});
const KINDS_SET = new Set(Object.keys(KINDS));
const SHA = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

function diff(before, after, file) {
  if (before === after) return '';
  const a = before.split('\n'), b = after.split('\n');
  let prefix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(a.length-prefix, b.length-prefix) &&
      a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3);
  const oldEnd = Math.min(a.length, a.length - suffix + 3);
  const newEnd = Math.min(b.length, b.length - suffix + 3);
  const oldLines = a.slice(start, oldEnd);
  const newLines = b.slice(start, newEnd);
  const oldChanged = Math.max(0, a.length - suffix - prefix);
  const newChanged = Math.max(0, b.length - suffix - prefix);
  const hunk = [
    ...a.slice(start, prefix).map(line => ' ' + line),
    ...a.slice(prefix, prefix + oldChanged).map(line => '-' + line),
    ...b.slice(prefix, prefix + newChanged).map(line => '+' + line),
    ...a.slice(a.length - suffix, oldEnd).map(line => ' ' + line),
  ];
  const patch = [
    '--- a/' + file, '+++ b/' + file,
    '@@ -' + (start + 1) + ',' + oldLines.length +
      ' +' + (start + 1) + ',' + newLines.length + ' @@',
    ...hunk,
  ].join('\n') + '\n';
  if (Buffer.byteLength(patch) > 65_536) throw Error('DIFF_TOO_LARGE');
  return patch;
}
function validArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      typeof args.workspaceId !== 'string' ||
      typeof args.path !== 'string' || !args.path ||
      args.path.length > 4_096 || args.path.includes('\0') ||
      !KINDS_SET.has(args.kind) ||
      args.syntax !== undefined && !['typescript','javascript','jsx','tsx'].includes(args.syntax) ||
      args.symbol !== undefined && (typeof args.symbol !== 'string' ||
        args.symbol.length < 1 || args.symbol.length > 128) ||
      args.maxResults !== undefined && (!Number.isInteger(args.maxResults) ||
        args.maxResults < 1 || args.maxResults > 100)) throw Error('INVALID_AST_ARGUMENTS');
}
function nodes(src, args) {
  const syntax = args.syntax ??
    (args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts')
      ? 'typescript' : args.path.endsWith('.jsx') ? 'jsx' : 'javascript');
  const plugins = syntax === 'typescript' ? ['typescript'] :
    syntax === 'tsx' ? ['typescript','jsx'] :
    syntax === 'jsx' ? ['jsx'] : [];
  let program;
  try { program = parse(src, {
    sourceType: 'unambiguous', errorRecovery: false, plugins,
    attachComment: false,
  }); } catch { throw Error('AST_PARSE_ERROR'); }
  const matches = [];
  const max = Math.min(args.maxResults ?? 50, 100);
  function walk(node, parent = null) {
    if (!node || typeof node !== 'object' ||
        matches.length >= max) return;
    if (node.type === KINDS[args.kind]) {
      const symbol = node.id?.name ?? node.key?.name ??
        node.name?.name ?? node.callee?.name ?? null;
      if (args.symbol === undefined || args.symbol === symbol) {
        // An exported declaration's text starts before the nested node.
        // Include its entire parent export for safe replacement without
        // leaving a stray 'export' / 'export default' prefix.
        const boundary = parent?.type === 'ExportNamedDeclaration' ||
          parent?.type === 'ExportDefaultDeclaration' ? parent : node;
        const start = boundary.start, end = boundary.end;
        matches.push({
          kind: args.kind, symbol, start, end,
          line: node.loc.start.line, column: node.loc.start.column + 1,
          excerpt: src.slice(start, Math.min(end, start + 512)),
        });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc','tokens','comments','errors','extra'].includes(key))
        continue;
      if (Array.isArray(child)) for (const inner of child) walk(inner, node);
      else if (child && typeof child === 'object' &&
          typeof child.type === 'string') walk(child, node);
    }
  }
  walk(program.program);
  return matches;
}
export function createStructuralTools({ workspaceRoots, authority, approvedAtomicWriter = null }) {
  if (!workspaceRoots || typeof workspaceRoots !== 'object' ||
      typeof authority?.requireGrant !== 'function' ||
      approvedAtomicWriter !== null && typeof approvedAtomicWriter !== 'function')
    throw TypeError('TRUSTED_AST_SCOPE_AND_ATOMIC_WRITER_REQUIRED');
  const roots = new Map();
  for (const [workspaceId, root] of Object.entries(workspaceRoots)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workspaceId) ||
        typeof root !== 'string' || !path.isAbsolute(root))
      throw TypeError('INVALID_AST_WORKSPACE');
    const actual = realpathSync(root), st = statSync(actual);
    if (!st.isDirectory() || actual === path.parse(actual).root)
      throw TypeError('INVALID_AST_WORKSPACE');
    roots.set(workspaceId, { actual, dev: st.dev, ino: st.ino });
  }
  async function source(scope, args, name, write = false) {
    validArgs(args);
    authority.requireGrant(scope, name, args.workspaceId, write);
    const root = roots.get(args.workspaceId);
    if (!root) throw Error('WORKSPACE_NOT_AUTHORIZED');
    const suffix = path.extname(args.path).toLowerCase();
    if (!['.ts','.tsx','.js','.jsx','.mjs','.cjs'].includes(suffix))
      throw Error('AST_UNSUPPORTED_SOURCE_TYPE');
    const handle = await openScopedFile(root.actual, args.path,
      { rootIdentity: root });
    try {
      const bytes = await readBoundedFile(handle);
      const content = new TextDecoder('utf-8',{ fatal:true }).decode(bytes);
      return {
        content, sourceSha256: hash(bytes), matches: nodes(content,args),
      };
    } finally { await handle.close(); }
  }
  async function astSearch(scope, args) {
    const result = await source(scope, args, 'ast_search');
    return Object.freeze({
      workspaceId: args.workspaceId, path: args.path,
      sourceSha256: result.sourceSha256, matches: result.matches,
      truncated: result.matches.length >= (args.maxResults ?? 50),
      source: 'typescript-ast',
    });
  }
  async function astRewrite(scope, args) {
    if (typeof args?.replacement !== 'string' ||
        Buffer.byteLength(args.replacement) > 16_384)
      throw Error('INVALID_AST_REPLACEMENT');
    const changing = args.dryRun === false;
    // A rewrite must detect ambiguity independently of any search display limit.
    const result = await source(scope, { ...args, maxResults: 2 }, 'ast_rewrite', changing);
    if (args.expectedSha256 !== undefined &&
        (!SHA.test(args.expectedSha256) ||
         result.sourceSha256 !== args.expectedSha256))
      throw Error('AST_SOURCE_CHANGED');
    if (result.matches.length !== 1) throw Error('AST_NON_UNIQUE_MATCH');
    const node = result.matches[0];
    const rewritten = result.content.slice(0, node.start) +
      args.replacement + result.content.slice(node.end);
    // Reject syntactically broken replacements before invoking a writer.
    nodes(rewritten, { ...args, maxResults: 1 });
    const patch = diff(result.content, rewritten, args.path);
    const response = {
      workspaceId: args.workspaceId, path: args.path, dryRun: !changing,
      originalSha256: result.sourceSha256,
      proposedSha256: hash(rewritten),
      unifiedDiff: patch, changed: rewritten !== result.content,
      match: node,
    };
    if (changing) {
      if (!approvedAtomicWriter) throw Error('AST_WRITE_BACKEND_NOT_APPROVED');
      // A trusted atomic writer must pin directories, compare source hash and
      // reject rename/update collisions; simple path.writeFile is prohibited.
      await approvedAtomicWriter({
        workspaceId: args.workspaceId, path: args.path,
        originalSha256: result.sourceSha256, proposedSha256: response.proposedSha256,
        content: rewritten,
      });
    }
    return Object.freeze(response);
  }
  return Object.freeze({ astSearch, astRewrite });
}
