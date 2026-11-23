// M4 composition loaded only on explicit operator activation. The native
// launcher boundary is external and must be approved per host in M5.
import { createMcpBridgeIntegration } from './mcp-milestone-integration.mjs';
import { acquireSubmissionLease } from '../../jobs/persistence/submission-exclusive-lease.mjs';
import { createSubmissionOutbox } from '../../jobs/persistence/submission-outbox.mjs';
import { createSubmissionCoordinator } from './submission-coordinator.mjs';
import { createSubmissionIngress } from './submission-ingress.mjs';
import { createSubmissionGitPreflight } from './submission-git-preflight.mjs';
import { createSubmissionPublicationAdapters } from './submission-publication.mjs';
import { createManagedProviderLauncher } from './managed-provider-launch.mjs';
import { createManagedSubmissionRunner } from './managed-submission-runner.mjs';
import { createSubmissionGithubBroker } from '../../integrations/submission-github-broker.mjs';
import { createSubmissionLinearWorker } from '../../integrations/submission-linear-worker.mjs';
import { lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { probeSandbox } from '../agent/mcp-host-agent/sandbox-runner.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST_BINDING='/etc/agent-bridge/managed-submission-host.mjs';
const deny=()=>Error('MANAGED_SUBMISSION_HOST_NOT_APPROVED');

export async function loadManagedSubmissionHost(){
  if(process.platform!=='linux')throw deny();
  // Do not import a module from a workspace, task payload or environment
  // path. Every ancestor must be root-owned and not group/world writable.
  for(let p=HOST_BINDING;;p=path.dirname(p)){
    const st=lstatSync(p);
    if(st.uid!==0||(st.mode&0o022)||st.isSymbolicLink()||
      (p===HOST_BINDING?!st.isFile():!st.isDirectory()))throw deny();
    if(p==='/')break;
  }
  const mod=await import(pathToFileURL(HOST_BINDING).href);
  if(typeof mod.createHostBinding!=='function')throw deny();
  return mod.createHostBinding();
}

// Startup gate: source fixtures do not authorize runtime activation. The
// root-owned binding must explicitly approve the exact clean release SHA
// and service host identity after a successful service-UID sandbox probe.
export async function verifyManagedSubmissionActivation(binding,repositoryRoot){
  if(process.platform!=='linux'||!process.getuid?.()||
    typeof binding?.verifyActivation!=='function')throw deny();
  const env={PATH:'/usr/bin:/bin',LANG:'C',GIT_OPTIONAL_LOCKS:'0'};
  // The sealed release is owned by root while the service runs as bridge.
  // Trust this one operator-pinned checkout only for Git's ownership check;
  // never grant a user-wide safe.directory exception.
  const git=args=>execFileSync('/usr/bin/git',
    ['-c','safe.directory='+repositoryRoot,'-C',repositoryRoot,...args],
    {encoding:'utf8',timeout:3000,env}).trim();
  const head=git(['rev-parse','HEAD']);
  if(!/^[a-f0-9]{40}$/.test(head)||
    git(['status','--porcelain','--untracked-files=no'])!=='')throw deny();
  const probe=probeSandbox();
  if(!probe.available||probe.uid!==process.getuid())throw deny();
  if(await binding.verifyActivation(Object.freeze({head,uid:probe.uid,
    hostId:'rebel-server',repositoryRoot}))!==true)throw deny();
}

export function createManagedSubmissionService({hostBinding:b,jobStore,jobsDir,
  projectsRoot,reviewInbox,reviewRoutingConfig,now=Date.now,
  allowRootForIsolatedTests=false,agyRunnerPath}){
  if(!b||!['resolvePlan','isolatedSpawn','loadPrivateKey','loadLinearToken',
    'loadWorkerSecret','verifyRecoveryRequest'].every(k=>typeof b[k]==='function')||
    !['githubMappings','linearMappings','workspaces','publicationPolicies'].every(k=>Array.isArray(b[k])&&b[k].length))throw deny();
  const broker=createSubmissionGithubBroker({mappings:b.githubMappings,
    loadPrivateKey:b.loadPrivateKey,allowPublication:true,now});
  const linearWorker=createSubmissionLinearWorker({mappings:b.linearMappings,
    loadLinearToken:b.loadLinearToken,loadWorkerSecret:b.loadWorkerSecret});
  const gitPreflight=createSubmissionGitPreflight({projectsRoot,workspaces:b.workspaces,
    githubBroker:broker,allowRootForIsolatedTests});
  const launchProvider=createManagedProviderLauncher({providerConfigs:b.providerConfigs,isolatedSpawn:b.isolatedSpawn,agyRunnerPath});
  const lease=acquireSubmissionLease(jobsDir);
  try {
  const outbox=createSubmissionOutbox(jobsDir);
  const launchProofs=new WeakMap();
  const ingress=createSubmissionIngress({jobStore,mappings:b.githubMappings,enabled:true,
    now,ttlMs:3600000,verifyLauncher:p=>launchProofs.get(p),
    verifyRunner:(actual,expected)=>actual===expected});
  const {adapters,verifyRecovery}=createSubmissionPublicationAdapters({
    gitPreflight,githubBroker:broker,linearWorker,reviewInbox,reviewRoutingConfig,
    publicationPolicies:b.publicationPolicies,verifyRecoveryRequest:b.verifyRecoveryRequest});
  const coordinator=createSubmissionCoordinator({jobStore,outbox,enabled:true,now,
    verifyAdmission:ingress.verifyAdmission,isAdmissionLive:ingress.isAdmissionLive,
    adapters,verifyRecovery});
  const runner=createManagedSubmissionRunner({jobStore,ingress,coordinator,
    captureHead:gitPreflight.captureHead,resolvePlan:async request=>{
      const plan=await b.resolvePlan(request);
      if(!plan||!b.githubMappings.some(m=>m.agentId===request.agent&&m.repository===request.repository&&
        m.appId===plan.appId&&m.installationId===plan.installationId)||
        !b.workspaces.some(w=>w.root===request.repositoryRoot&&w.repository===request.repository)||
        !b.linearMappings.some(m=>m.agentId===request.agent&&m.tenantId===request.tenantId)||
        !b.publicationPolicies.some(p=>p.agentId===request.agent&&p.repository===request.repository))throw deny();
      return plan;
    },
    launchProvider,launchProofs,enabled:true,now});
  // For the future authenticated MCP route: both entrypoints share this
  // live runner set, ingress, journal, publication adapters and review inbox.
  // Only the transport's trusted admission/tool verifiers can bind MCP jobs.
  return Object.freeze({...runner,createMcpIntegration:({memory,verifyAdmittedJob,
    verifyToolReceipt,verifyD5Handoff})=>createMcpBridgeIntegration({
    jobStore,memory,reviewInbox,verifyAdmittedJob,verifyToolReceipt,verifyD5Handoff,
    submitAdmittedWork:runner.submitAdmittedWork,now})});
  } catch(error){lease.release();throw error;}
}


// Offline operator-only composition. No native launcher, publication token,
// or active runner grant. The host must attest quiescence per job; the lease
// excludes another managed runtime or recovery reader on the same ledger.
export function createManagedRecoveryService({hostBinding:b,jobStore,jobsDir,
  projectsRoot,reviewInbox,reviewRoutingConfig,now=Date.now,allowRootForIsolatedTests=false}){
  if(!b||typeof b.verifyRecoveryRequest!=='function'||
    typeof b.verifyOperatorRecovery!=='function'||typeof b.assertQuiescent!=='function')throw deny();
  const lease=acquireSubmissionLease(jobsDir);
  let outbox;
  try{
    outbox=createSubmissionOutbox(jobsDir);
    const githubBroker=createSubmissionGithubBroker({mappings:b.githubMappings,
      loadPrivateKey:b.loadPrivateKey,allowObservation:true,now});
    const linearWorker=createSubmissionLinearWorker({mappings:b.linearMappings,
      loadLinearToken:b.loadLinearToken,loadWorkerSecret:()=>{throw deny();}});
    const gitPreflight=createSubmissionGitPreflight({projectsRoot,workspaces:b.workspaces,
      githubBroker,allowRootForIsolatedTests});
    const {adapters,verifyRecovery}=createSubmissionPublicationAdapters({
      gitPreflight,githubBroker,linearWorker,reviewInbox,reviewRoutingConfig,
      publicationPolicies:b.publicationPolicies,verifyRecoveryRequest:b.verifyRecoveryRequest});
    const coordinator=createSubmissionCoordinator({jobStore,outbox,enabled:true,now,
      verifyAdmission:()=>null,adapters,verifyRecovery,
      operatorRecovery:{verify:b.verifyOperatorRecovery,assertExclusive:lease.isHeld,
        assertQuiescent:b.assertQuiescent}});
    return Object.freeze({recoverInterrupted:coordinator.recoverInterrupted,
      close:()=>{try{outbox.close();}finally{lease.release();}}});
  }catch(error){try{outbox?.close();}finally{lease.release();}throw error;}
}
