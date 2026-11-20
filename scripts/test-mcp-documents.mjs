// ABR-98 offline PDF bytes/integrity, no Chrome downloads or host file I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createExecutionAuthority } from '../bridge/agent/mcp-host-agent/execution-authority.mjs';
import { renderOfflineMarkdownPdf, editOfflinePdf,
  createScopedPdfExport } from '../bridge/agent/mcp-host-agent/pdf-offline.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const grants = {
  'owner@example.invalid': {
    clients:['test-client'],sessions:['pdf-session'],
    devices:['ubuntu-fixture'],workspaces:['docs'],
    tools:['write_pdf'],write:true,
  },
  'viewer@example.invalid': {
    clients:['test-viewer'],sessions:['pdf-session'],
    devices:['ubuntu-fixture'],workspaces:['docs'],
    tools:['write_pdf'],write:false,
  },
};
const auth = () => createExecutionAuthority({deviceId:'ubuntu-fixture',grants});
function issue(authority,subject,clientId){
  return authority.issueFromVerifiedIdentity({subject,clientId,sessionId:'pdf-session',
    authenticatedDeviceId:'ubuntu-fixture'});
}
test('ABR-98 render offline simple Markdown headings/bullets and paginate',async()=>{
  const text='# Report\n\n## Executive summary\n- First item\n- Second item\n'+
    ('Plain text wraps at the page margin. '.repeat(25)+'\n').repeat(35);
  const result=await renderOfflineMarkdownPdf(text,{pageSize:'A4',title:'Fixture Report'});
  assert.ok(result.bytes.length>1_000);
  assert.equal(Buffer.from(result.bytes.subarray(0,5)).toString(),'%PDF-');
  assert.equal(result.sha256,sha(result.bytes));
  assert.ok(result.pages>=2);
  const pdf=await PDFDocument.load(result.bytes);
  assert.equal(pdf.getPageCount(),result.pages);
  assert.ok(Math.abs(pdf.getPage(0).getWidth()-595.28)<0.5);
  assert.ok(pdf.getTitle()==='Fixture Report');
  assert.equal(result.renderer,'pdf-lib-offline');
});
test('ABR-98 page insert/delete uses approved bytes and preserves original source',async()=>{
  const original=(await renderOfflineMarkdownPdf('# Source\nOriginal text')).bytes;
  const inserted=(await renderOfflineMarkdownPdf('# Second\nInserted text')).bytes;
  const sourceSha=sha(original);
  const result=await editOfflinePdf({sourcePdf:original,operations:[
    {type:'insert',pageIndex:1,sourcePdfPath:'second.pdf'},
  ],readApprovedPdf:async name=>{
    assert.equal(name,'second.pdf');return inserted;
  }});
  assert.equal(result.pages,2);
  assert.equal((await PDFDocument.load(result.bytes)).getPageCount(),2);
  const removed=await editOfflinePdf({sourcePdf:result.bytes,operations:[
    {type:'delete',pageIndexes:[0]},
    {type:'insert',pageIndex:1,markdown:'# Third'},
  ],readApprovedPdf:async()=>{throw Error('UNEXPECTED_FILE_OPEN');}});
  assert.equal(removed.pages,2);
  assert.equal(sha(original),sourceSha,'Original PDF never mutated');
  await assert.rejects(editOfflinePdf({sourcePdf:original,operations:[
    {type:'delete',pageIndexes:[0]},
  ],readApprovedPdf:async()=>inserted}),/INVALID_PDF_PAGE_INDEX/);
  await assert.rejects(editOfflinePdf({sourcePdf:original,operations:[
    {type:'insert',pageIndex:3,markdown:'Bad index'},
  ],readApprovedPdf:async()=>inserted}),/INVALID_PDF_INSERT/);
  await assert.rejects(editOfflinePdf({sourcePdf:original,operations:[
    {type:'insert',pageIndex:0,sourcePdfPath:'../outside.pdf'},
  ],readApprovedPdf:async()=>inserted}),/INVALID_PDF_INSERT/);
});
test('ABR-98 distinct PDF write grant and atomic output preserves bytes on failure',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'abr98-pdf-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const existing=path.join(root,'report.pdf');
  const original=(await renderOfflineMarkdownPdf('# Existing')).bytes;
  await writeFile(existing,original,{flag:'wx'});
  const authority=auth();
  const owner=issue(authority,'owner@example.invalid','test-client');
  const viewer=issue(authority,'viewer@example.invalid','test-viewer');
  let writes=0;
  const exporter=createScopedPdfExport({
    authority,
    readApprovedPdf:async({workspaceId,path:filename})=>{
      assert.equal(workspaceId,'docs');
      return new Uint8Array(await readFile(path.join(root,filename)));
    },
    atomicOutput:async({workspaceId,path:filename,bytes,sha256})=>{
      assert.equal(workspaceId,'docs');
      assert.equal(sha(bytes),sha256);
      const tmp=path.join(root,randomUUID()+'.tmp');
      await writeFile(tmp,bytes,{flag:'wx'});
      await rename(tmp,path.join(root,filename));
      writes++;
    },
  });
  await assert.rejects(exporter.writePdf(viewer,{
    workspaceId:'docs',path:'report.pdf',content:'# Denied',
  }),/EXECUTION_NOT_AUTHORIZED/);
  assert.equal(writes,0);
  assert.equal(sha(await readFile(existing)),sha(original));
  await assert.rejects(exporter.writePdf(owner,{
    workspaceId:'docs',path:'../escape.pdf',content:'# Denied',
  }),/INVALID_PDF_PATH/);
  assert.equal(writes,0);
  await assert.rejects(exporter.writePdf(owner,{
    workspaceId:'docs',path:'report.pdf',content:'\u{1f4a5} emoji unsupported',
  }),/UNSUPPORTED_PDF_GLYPH/);
  assert.equal(sha(await readFile(existing)),sha(original));
  assert.equal(writes,0);
  const success=await exporter.writePdf(owner,{
    workspaceId:'docs',path:'report.pdf',content:'# Authorized\nNew report',
    options:{title:'Authorized Fixture'},
  });
  assert.equal(success.pages,1);
  assert.equal(writes,1);
  assert.equal(sha(await readFile(existing)),success.sha256);
  assert.equal((await PDFDocument.load(await readFile(existing))).getTitle(),'Authorized Fixture');
  const changed=await exporter.writePdf(owner,{
    workspaceId:'docs',path:'report.pdf',outputPath:'version2.pdf',
    content:[{type:'insert',pageIndex:1,markdown:'# Added page'}],
  });
  assert.equal(changed.pages,2);
  assert.equal(writes,2);
  assert.equal((await PDFDocument.load(await readFile(path.join(root,'version2.pdf')))).getPageCount(),2);
  assert.equal((await PDFDocument.load(await readFile(existing))).getPageCount(),1);
});
