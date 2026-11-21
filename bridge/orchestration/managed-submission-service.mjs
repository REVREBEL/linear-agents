// M4 composition loaded only on explicit operator activation. The native
// launcher boundary is external and must be approved per host in M5.
import { createMcpBridgeIntegration } from './mcp-milestone-integration.mjs';
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
}
