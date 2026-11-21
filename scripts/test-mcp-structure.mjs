// ABR-98 real offline Linux sandbox Git and TS AST fixture tests.
// Must never mutate production repos or execute unapproved host commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSandboxRunner, probeSandbox } from '../bridge/agent/mcp-host-agent/sandbox-runner.mjs';
import { createExecutionAuthority } from '../bridge/agent/mcp-host-agent/execution-authority.mjs';
import { createReadOnlyGitTools } from '../bridge/agent/mcp-host-agent/git-readonly.mjs';
import { createStructuralTools } from '../bridge/agent/mcp-host-agent/ast-structured.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const tools = ['git_status','git_diff','git_log','ast_search','ast_rewrite'];
const grant = {
  clients:['fixture-client'],sessions:['fixture-session'],
  devices:['ubuntu-fixture'],workspaces:['repo'],tools,write:true,
};
async function setup(t) {
  const root=await mkdtemp(path.join(tmpdir(), 'abr98-structure-'));
  const projects=path.join(root,'projects');
  const repo=path.join(projects,'repo');
  await mkdir(repo,{recursive:true});
  await writeFile(path.join(repo,'module.ts'),
    'export function greet(name: string): string { return "Hello " + name; }\n'+
    'export const version = 1;\n');
  execFileSync('git',['init','-q'],{cwd:repo});
  execFileSync('git',['config','user.name','Fixture'],{cwd:repo});
  execFileSync('git',['config','user.email','fixture@example.invalid'],{cwd:repo});
  execFileSync('git',['add','module.ts'],{cwd:repo});
  execFileSync('git',['commit','-qm','test initial'],{cwd:repo});
  await writeFile(path.join(repo,'module.ts'),
    'export function greet(name: string): string { return "Hello " + name + "!"; }\n'+
    'export const version = 1;\n');
  const authority = createExecutionAuthority({
    deviceId:'ubuntu-fixture',
    grants:{ 'engineer@example.invalid':grant,
      'reader@example.invalid': {...grant, clients:['reader-client'],write:false} },
  });
  const scoped = authority.issueFromVerifiedIdentity({
    subject:'engineer@example.invalid', clientId:'fixture-client',
    sessionId:'fixture-session',authenticatedDeviceId:'ubuntu-fixture',
  });
  const readOnly = authority.issueFromVerifiedIdentity({
    subject:'reader@example.invalid', clientId:'reader-client',
    sessionId:'fixture-session',authenticatedDeviceId:'ubuntu-fixture',
  });
  const runner=createSandboxRunner({
    projectsRoot:projects,workspaces:{repo},
    expectedUid:process.getuid(),allowRootForIsolatedTests:true,
    maxDurationMs:8_000,
  });
  t.after(async()=>rm(root,{recursive:true,force:true}));
  return {root,repo,runner,authority,scoped,readOnly};
}
test('ABR-98 structured TypeScript AST search and real unified dry-run diff',async t=>{
  if(!probeSandbox().available && process.env.ABR98_REQUIRE_SANDBOX==='1')
    throw Error('REQUIRED_SANDBOX_UNAVAILABLE');
  const {repo,authority,scoped,readOnly}=await setup(t);
  const tool=createStructuralTools({workspaceRoots:{repo},authority});
  const args={workspaceId:'repo',path:'module.ts',kind:'functionDeclaration',symbol:'greet'};
  const before=await readFile(path.join(repo,'module.ts'),'utf8');
  const matches=await tool.astSearch(readOnly,args);
  assert.equal(matches.matches.length,1);
  assert.equal(matches.matches[0].symbol,'greet');
  assert.equal(matches.matches[0].line,1);
  assert.equal(matches.sourceSha256,hash(before));
  assert.ok(matches.matches[0].excerpt.includes('Hello'));
  const replacement='export function greet(name: string): string { return name.toUpperCase(); }';
  const dry=await tool.astRewrite(readOnly,{...args,replacement});
  assert.equal(dry.dryRun,true);
  assert.equal(dry.originalSha256,hash(before));
  assert.ok(dry.unifiedDiff.startsWith('--- a/module.ts\n+++ b/module.ts\n@@ -'));
  assert.match(dry.unifiedDiff,/^\-export function greet/m);
  assert.match(dry.unifiedDiff,/^\+export function greet/m);
  assert.equal(await readFile(path.join(repo,'module.ts'),'utf8'),before);
  await assert.rejects(tool.astRewrite(readOnly,{
    ...args,replacement,dryRun:false,
  }),/EXECUTION_NOT_AUTHORIZED/);
  await assert.rejects(tool.astRewrite(scoped,{
    ...args,replacement,dryRun:false,
  }),/AST_WRITE_BACKEND_NOT_APPROVED/);
  await assert.rejects(tool.astRewrite(scoped,{
    ...args,replacement,expectedSha256:'0'.repeat(64),
  }),/AST_SOURCE_CHANGED/);
  await assert.rejects(tool.astSearch(scoped,{
    ...args,path:'../../outside.ts',
  }),/OUTSIDE_AUTHORIZED_WORKSPACE/);
});
test('ABR-98 approved atomic AST writer verifies source collision before edit',async t=>{
  const {repo,authority,scoped}=await setup(t);
  let calls=0;
  const tool=createStructuralTools({
    workspaceRoots:{repo},authority,
    approvedAtomicWriter:async ({path:relative,originalSha256,content})=>{
      // Test-only writer. Production must provide a validated dirfd-based
      // collision-aware atomic writer before enabling a mutation handler.
      const file=path.join(repo,relative),current=await readFile(file,'utf8');
      if(hash(current)!==originalSha256)throw Error('AST_SOURCE_CHANGED');
      const temporary=file+'.'+randomUUID()+'.tmp';
      await writeFile(temporary,content,{flag:'wx',mode:0o600});
      await rename(temporary,file);
      calls++;
    },
  });
  const args={workspaceId:'repo',path:'module.ts',kind:'functionDeclaration',
    symbol:'greet',replacement:'export function greet() { return 12; }',
    dryRun:false};
  const result=await tool.astRewrite(scoped,args);
  assert.equal(result.dryRun,false);
  assert.equal(calls,1);
  assert.equal(hash(await readFile(path.join(repo,'module.ts'))),result.proposedSha256);
  await assert.rejects(tool.astRewrite(scoped,{
    ...args,expectedSha256:result.originalSha256,
  }),/AST_SOURCE_CHANGED/);
});
test('ABR-98 Git status, bounded diff/log use isolated read-only sandbox',async t=>{
  const supported=probeSandbox();
  if(!supported.available){
    if(process.env.ABR98_REQUIRE_SANDBOX==='1')throw Error('REQUIRED_SANDBOX_UNAVAILABLE: '+supported.error);
    return t.skip('OS namespaces denied — no unsandboxed Git fallback');
  }
  const {repo,runner,authority,scoped,readOnly}=await setup(t);
  const git=createReadOnlyGitTools({runner,authority});
  const status=await git.gitStatus(readOnly,{workspaceId:'repo'});
  assert.equal(status.exitCode,0,JSON.stringify(status));
  assert.equal(status.source,'sandboxed-git');
  assert.match(status.stdout,/module.ts/);
  const diff=await git.gitDiff(readOnly,{workspaceId:'repo',pathspec:'module.ts'});
  assert.equal(diff.exitCode,0,JSON.stringify(diff));
  assert.match(diff.stdout,/Hello/);
  assert.match(diff.stdout,/\+export function greet/);
  const log=await git.gitLog(readOnly,{workspaceId:'repo',limit:3});
  assert.equal(log.exitCode,0,JSON.stringify(log));
  assert.match(log.stdout,/test initial/);
  assert.match(log.stdout,/^[a-f0-9]{40} /);
  assert.equal(status.sha256,hash(status.stdout));
  await assert.rejects(git.gitDiff(scoped,{
    workspaceId:'repo',pathspec:'../secret',
  }),/INVALID_GIT_ARGUMENTS/);
  for (const unsafe of ['@file', '+file', ':(exclude)module.ts']) {
    await assert.rejects(git.gitDiff(scoped,{
      workspaceId:'repo',pathspec:unsafe,
    }),/INVALID_GIT_ARGUMENTS/);
  }
  assert.equal((await readFile(path.join(repo,'module.ts'),'utf8')).includes('Hello'),true);
});

test('AST rewrite refuses ambiguous matches even with a one-result limit', async t => {
  const { repo, authority, scoped } = await setup(t);
  const file = path.join(repo, 'module.ts');
  const original = 'function first() { return 1; }\nfunction second() { return 2; }\n';
  await writeFile(file, original);
  let writes = 0;
  const tool = createStructuralTools({ workspaceRoots: {repo}, authority,
    approvedAtomicWriter: async () => { writes++; } });
  for (const dryRun of [true, false]) {
    await assert.rejects(tool.astRewrite(scoped, {
      workspaceId:'repo', path:'module.ts', kind:'functionDeclaration',
      maxResults:1, replacement:'function changed() {}', dryRun,
    }), /AST_NON_UNIQUE_MATCH/);
  }
  assert.equal(writes, 0);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('ABR-98 dry-run patches round-trip through git apply with exact EOF bytes', async t => {
  const {repo, authority, scoped} = await setup(t);
  const tool = createStructuralTools({workspaceRoots:{repo}, authority});
  const file = path.join(repo, 'module.ts');
  const oldBody = 'export function greet() { return 1; }';
  const replacement = 'export function greet() { return 2; }';
  const cases = [
    ['single line with newline', oldBody + '\n', replacement + '\n'],
    ['single line without newline', oldBody, replacement],
    ['CRLF terminated', 'const top = 1;\r\n' + oldBody + '\r\n',
      'const top = 1;\r\n' + replacement + '\r\n'],
    ['unchanged no-newline EOF context', oldBody + '\nexport const tail = 1;',
      replacement + '\nexport const tail = 1;'],
    ['unchanged trailing context', 'export const top = 1;\n' + oldBody +
      '\nexport const tail = 1;\n', 'export const top = 1;\n' + replacement +
      '\nexport const tail = 1;\n'],
  ];
  for (const [name, original, expected] of cases) {
    await t.test(name, async () => {
      await writeFile(file, original);
      const dry = await tool.astRewrite(scoped, {
        workspaceId:'repo', path:'module.ts',
        kind:'functionDeclaration', symbol:'greet',
        replacement, expectedSha256:hash(original),
      });
      assert.equal(dry.dryRun,true);
      assert.equal(dry.proposedSha256,hash(expected));
      assert.ok(dry.unifiedDiff.startsWith('--- a/module.ts\n+++ b/module.ts\n'));
      assert.doesNotThrow(() => execFileSync('git', ['apply','--check','-'], {
        cwd:repo, input:dry.unifiedDiff,
      }), name + ' patch should apply');
      execFileSync('git',['apply','-'],{cwd:repo,input:dry.unifiedDiff});
      assert.equal((await readFile(file)).toString('utf8'),expected);
      assert.equal(hash(await readFile(file)),dry.proposedSha256);
    });
  }
});
