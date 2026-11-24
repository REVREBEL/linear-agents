import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ORG = /^[A-Za-z0-9_-]{2,128}$/;
const GUID = /^[A-Za-z0-9_-]{8,128}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const deny = () => Error('EVENT_INTELLIGENCE_EVIDENCE_DENIED');

/** Verify a durable private intake and use only operator-pinned reviewer scopes. */
export function createEventIntelligenceEnricher({ githubBroker, approvedScopes } = {}) {
  if (!githubBroker || typeof githubBroker.forReviewScope !== 'function' ||
      !Array.isArray(approvedScopes) || approvedScopes.length < 1) throw deny();
  const map = new Map();
  for (const scope of approvedScopes) {
    if (!scope || scope.agentId !== 'chatgpt-review' ||
        !ORG.test(scope.organizationId || '') || !REPO.test(scope.repository || '') ||
        scope.repository.split('/').some(part => part==='.'||part==='..') ||
        ![scope.appId,scope.installationId].every(id => /^[1-9][0-9]{0,15}$/.test(id)) ||
        !Array.isArray(scope.requiredChecks) || scope.requiredChecks.length<1 ||
        scope.requiredChecks.length>50) throw deny();
    const key = scope.organizationId+'\0'+scope.repository;
    if (map.has(key)) throw deny();
    map.set(key, Object.freeze({
      agentId: scope.agentId, organizationId: scope.organizationId,
      repository: scope.repository, appId: scope.appId,
      installationId: scope.installationId,
      requiredChecks: Object.freeze(scope.requiredChecks.map(c => Object.freeze({
        name:c.name,appId:c.appId,
      }))),
    }));
  }
  return Object.freeze({
    async enrich(receipt) {
      // Only a fully persisted private Worker intake is a valid starting
      // point. The signed notification PR URL supplies a candidate, never
      // source-of-truth or permission to query an arbitrary repo.
      if (receipt?.schemaVersion!==2||receipt.provider!=='linear'||
          receipt.state!=='durable_intake'||receipt.durable!==true||
          receipt.dispatched!==false||receipt.dispatchStatus!=='not_started'||
          receipt.reviewLaunchStatus!=='not_started'||
          receipt.workerIdentity!=='linear-chatgpt-agent'||
          !HASH.test(receipt.deliveryHash||'')||
          !HASH.test(receipt.signedPayloadSha256||'')||
          receipt.deliveryId!=='event:'+receipt.signedPayloadSha256||
          !ORG.test(receipt.organizationId||'')||
          !GUID.test(receipt.issueId||'')||
          receipt.verifiedIssue?.id!==receipt.issueId||
          receipt.verifiedIssue?.organizationId!==receipt.organizationId||
          receipt.providerFactsVerifiedBy!=='linear-oauth-app'||
          !REPO.test(receipt.prCandidate?.repository||'')||
          !Number.isSafeInteger(receipt.prCandidate?.number) ||
          receipt.prCandidate.number<1) throw deny();
      const cfg=map.get(receipt.organizationId+'\0'+receipt.prCandidate.repository);
      if (!cfg) throw deny();
      const facade=await githubBroker.forReviewScope({
        agentId:cfg.agentId,repository:cfg.repository,
        appId:cfg.appId,installationId:cfg.installationId,
      });
      const evidence=await facade.observeReview(receipt.prCandidate.number,cfg.requiredChecks);
      if (evidence.source!=='github-app-readonly'||
          evidence.repository!==cfg.repository||
          evidence.pullNumber!==receipt.prCandidate.number||
          evidence.installationId!==cfg.installationId||
          !SHA.test(evidence.headSha)||!SHA.test(evidence.baseSha)||
          evidence.dispatchAuthorized!==false||
          evidence.dispatched!==false||evidence.reviewLaunchStatus!=='not_started') throw deny();
      // A verified GitHub PR is NOT proof that it belongs to this Linear
      // issue. Until an independently verified issue/PR relation is present,
      // the enrichment's only policy outcome is 'defer'.
      return Object.freeze({
        schemaVersion:1,source:'github-app-readonly',
        deliveryHash:receipt.deliveryHash,organizationId:cfg.organizationId,
        issueId:receipt.issueId,issueIdentifier:receipt.verifiedIssue.identifier,
        repository:cfg.repository,pullNumber:evidence.pullNumber,
        headSha:evidence.headSha,baseSha:evidence.baseSha,
        ciStatus:evidence.ciStatus,githubContextReady:evidence.githubContextReady,
        unresolvedThreads:evidence.unresolvedThreads,
        changesRequestedReviews:evidence.changesRequestedReviews,
        githubEvidenceObservedAt:evidence.observedAt,
        linkedIssueVerified:false,
        outcome:'defer',reason:'await-verified-linear-pr-link-and-launch-ack',
        reviewLaunchStatus:'not_started',dispatchAuthorized:false,dispatched:false,
        evidenceKey:sha256(JSON.stringify([
          'abr18-gh-evidence-v1',receipt.organizationId,
          cfg.repository,evidence.pullNumber,evidence.headSha,
          evidence.baseSha,receipt.deliveryHash,
        ])),
      });
    },
  });
}

/**
 * Explicit review progress status. Neither a queued inbox task nor the
 * Shortcuts HANDOFF_ATTEMPTED marker proves ChatGPT launched or accepted a
 * review. A published-review claim is trusted only after a fresh independent
 * GitHub verification by the existing review-delivery verifier.
 */
export async function reconcileReviewProgress(record, {
  githubEvidence, verifyPublishedReview,
} = {}) {
  if (!record || record.role!=='chatgpt-user-review' ||
      !HASH.test(record.reviewId||'')||!REPO.test(record.repository||'')||
      !Number.isSafeInteger(record.number)||record.number<1||
      !SHA.test(record.headSha||'')||!githubEvidence||
      githubEvidence.source!=='github-app-readonly'||
      githubEvidence.repository!==record.repository||
      githubEvidence.pullNumber!==record.number||
      githubEvidence.headSha!==record.headSha) throw deny();
  const base={
    reviewId:record.reviewId,repository:record.repository,pullNumber:record.number,
    headSha:record.headSha,dispatchAuthorized:false,
  };
  if (record.state==='reviewed') {
    if (!Number.isSafeInteger(record.delivery?.githubReviewId)||
        record.delivery.githubReviewId<1||
        record.delivery.githubReviewedCommit!==record.headSha||
        typeof verifyPublishedReview!=='function') throw deny();
    const verified=await verifyPublishedReview(record,record.delivery);
    if (verified?.githubReviewId!==record.delivery.githubReviewId||
        verified.githubReviewedCommit!==record.headSha||
        !verified.verifiedAt) throw deny();
    return Object.freeze({...base,reviewLaunchStatus:'published-review-verified',
      githubReviewId:verified.githubReviewId});
  }
  if (!['pending','claimed','blocked'].includes(record.state)) throw deny();
  const handoff=record.messageHandoff?.state;
  return Object.freeze({...base,
    reviewLaunchStatus:record.state==='blocked'?'blocked':
      handoff==='attempted'?'handoff-attempted-unverified':
      handoff==='uncertain'?'handoff-uncertain':
      record.state==='claimed'?'claimed-unverified':'not_started',
  });
}
