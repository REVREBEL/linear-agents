import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,defaultScope as scope,input,A,B,REPO,uuid} from './fixtures/submission-provider-fixture.mjs';

test('M3 real HTTP adapters via fixture transport publish and verify one PR, comment, state, queue and session',async t=>{
  const x=await setup(t);
  const first=await x.coordinator.submit(x.handle,input);
  assert.equal(first.stage,'session_closed');assert.equal(first.prNumber,42);
  assert.equal(first.reviewQueued,true);assert.equal(first.reviewerAcknowledged,false);
  assert.deepEqual(x.effects,['github','comment','state','worker']);
  assert.equal((await x.inbox.list()).length,1);
  const again=await x.coordinator.submit(x.handle,input);
  assert.equal(again.submissionId,first.submissionId);
  assert.equal(x.effects.length,4);
  assert.ok(!JSON.stringify(x.outbox.get(first.submissionId)).includes('fixture-worker-secret'));
  x.newHead();
  const rev={...scope,jobKey:'antigravity:revision',sessionId:uuid(20),cycle:'cycle2',headSha:B};
  await x.record(rev);const h=await x.admit(x.coordinator,rev);
  const next=await x.coordinator.submit(h,{...input,summary:'Revision fixture'});
  assert.equal(next.stage,'session_closed');assert.equal(next.prNumber,42);assert.equal(next.headSha,B);
  assert.deepEqual(x.effects,['github','comment','state','worker','comment','state','worker']);
  assert.equal((await x.inbox.list()).length,2);
});
test('M3 independently observed effects reconcile after lost response without replay',async t=>{
  for(const [lost,pending] of [['github','github_published'],['comment','linear_posted'],['state','in_review'],['worker','session_closed']]){
    await t.test(lost,async child=>{
      const x=await setup(child,{lost});const one=await x.coordinator.submit(x.handle,input);
      assert.equal(one.pending,pending);
      const restart=x.connect(),handle=await x.admit(restart.coordinator);
      assert.equal((await restart.coordinator.submit(handle,input)).pending,pending);
      await assert.rejects(restart.coordinator.reconcilePending(handle,{}),/NOT_VERIFIED/);
      assert.equal((await restart.coordinator.reconcilePending(handle,x.recovery)).stage,pending);
      assert.equal((await restart.coordinator.submit(handle,input)).stage,'session_closed');
      assert.deepEqual(x.effects,['github','comment','state','worker']);
    });
  }
});
test('M3 draft never transitions Linear until independently verified ready',async t=>{
  const x=await setup(t,{mode:'draft'});
  const one=await x.coordinator.submit(x.handle,input);assert.equal(one.pending,'github_published');
  assert.equal(x.getPr().draft,true);assert.deepEqual(x.effects,['github']);
  await assert.rejects(x.coordinator.reconcilePending(x.handle,x.recovery),/NOT_VERIFIED/);
  x.ready();await x.coordinator.reconcilePending(x.handle,x.recovery);
  assert.equal((await x.coordinator.submit(x.handle,input)).stage,'session_closed');
  assert.deepEqual(x.effects,['github','comment','state','worker']);
});
test('M3 wrong author, Linear identity, stale Git and unverified session fail closed',async t=>{
  for(const [opts,pending,effects] of [
    [{wrongAuthor:true},'github_published',['github']],
    [{wrongActor:true},'linear_posted',['github']],
    [{unverifiedSession:true},'session_closed',['github','comment','state','worker']],
  ])await t.test(pending,async child=>{
    const x=await setup(child,opts);const r=await x.coordinator.submit(x.handle,input);
    assert.equal(r.pending,pending);assert.deepEqual(x.effects,effects);
  });
  await t.test('git changed',async child=>{
    const x=await setup(child);x.changeGit();
    assert.equal((await x.coordinator.submit(x.handle,input)).pending,'git_ready');
    assert.deepEqual(x.effects,[]);
  });
});
test('M3 explicit failed/blocked submissions close only failed session; persist and never publish',async t=>{
  for(const outcome of ['failed','blocked'])await t.test(outcome,async child=>{
    const x=await setup(child);
    const request={...input,outcome};
    const r=await x.coordinator.submitFailure(x.handle,request);
    assert.equal(r.stage,outcome);assert.deepEqual(x.effects,['worker']);
    assert.equal(r.reviewQueued,false);assert.equal((await x.inbox.list()).length,0);
    assert.equal((await x.coordinator.submitFailure(x.handle,request)).stage,outcome);
    await assert.rejects(x.coordinator.submit(x.handle,input),/RECEIPT_CONFLICT/);
    assert.deepEqual(x.effects,['worker']);
  });
});


test('M3 refuses a replacement for a closed historical PR and stale head at downstream mutation boundary',async t=>{
  await t.test('closed prior PR',async child=>{
    const x=await setup(child,{closedPrior:true});
    assert.equal((await x.coordinator.submit(x.handle,input)).pending,'github_published');
    assert.deepEqual(x.effects,[]);
  });
  await t.test('head changed during Linear comment lookup',async child=>{
    const x=await setup(child,{changeHeadBeforeComment:true});
    assert.equal((await x.coordinator.submit(x.handle,input)).pending,'linear_posted');
    assert.deepEqual(x.effects,['github']);
  });
});


test('M3 direct Linear session observation denies wrong session owner and wrong terminal activity author',async t=>{
  for(const [opts,effects] of [[{wrongSession:true},['github','comment','state']],[{wrongActivity:true},['github','comment','state','worker']]]){
    await t.test(JSON.stringify(opts),async child=>{
      const x=await setup(child,opts);
      assert.equal((await x.coordinator.submit(x.handle,input)).pending,'session_closed');
      assert.deepEqual(x.effects,effects);
    });
  }
});


test('M3 missing reviewer route is rejected before publication',async t=>{
  const x=await setup(t,{noRoute:true});
  assert.equal((await x.coordinator.submit(x.handle,input)).pending,'github_published');
  assert.deepEqual(x.effects,[]);
});
test('M3 failed session lost response reconciles by direct Linear observation without a second completion',async t=>{
  const x=await setup(t,{lost:'worker'});
  const request={...input,outcome:'failed'};
  const r=await x.coordinator.submitFailure(x.handle,request);
  assert.equal(r.pending,'failed');
  const restart=x.connect(),h=await x.admit(restart.coordinator);
  assert.equal((await restart.coordinator.submitFailure(h,request)).pending,'failed');
  const observed=await restart.coordinator.reconcilePending(h,x.recovery);
  assert.equal(observed.stage,'failed');
  assert.deepEqual(x.effects,['worker']);
});
