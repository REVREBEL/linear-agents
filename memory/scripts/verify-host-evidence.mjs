import { readOperatorFile, loadOperatorSigningKey } from "../host-memory-authority.mjs";
import { createHostEvidenceClients } from "../host-evidence-clients.mjs";
import { verifyPromotionFromGitHub } from "../promotion-verification.mjs";
const root="/var/lib/bridge-memory-authority";
let stage="operator-root";
try{
  if(process.getuid?.()!==0)throw Error("operator identity required");
  const configured=await loadOperatorSigningKey(root);
  configured.key.fill(0);
  stage="operator-canary-config";
  const {job,policy}=JSON.parse((await readOperatorFile(root,"canary.json",16384)).toString("utf8"));
  if(!Array.isArray(policy?.permittedReviewers)||!policy.permittedReviewers.length||
    !Array.isArray(policy?.allowedCheckApps)||!policy.allowedCheckApps.length||
    !Array.isArray(policy?.requiredChecks)||!policy.requiredChecks.length)throw Error("pinned policy required");
  stage="pinned-evidence-provider";
  const {github,linear}=await createHostEvidenceClients({root,job});
  stage="github-reviewed-sha-and-required-ci";
  const {scope,prNumber,headSha}=job;
  const proof=await verifyPromotionFromGitHub({scope,prNumber,expectedHeadSha:headSha,github,
    requiredChecks:policy.requiredChecks,allowedCheckApps:policy.allowedCheckApps,permittedReviewers:policy.permittedReviewers});
  stage="linear-completed-linked-pr";
  const completion=await linear.getIssue(scope.issueId);
  if(completion.statusType!=="completed")throw Error("completion denied");
  console.log(JSON.stringify({hostEvidenceCanary:"passed",prNumber,headSha,checks:proof.checks.length,linearCompleted:true}));
}catch{
  console.error(JSON.stringify({hostEvidenceCanary:"denied",stage}));
  process.exitCode=1;
}
