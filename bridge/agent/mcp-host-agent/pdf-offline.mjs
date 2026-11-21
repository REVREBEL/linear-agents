// ABR-98 — offline PDF creation/editing without Chrome/Puppeteer downloads.
// pdf-lib@1.17.1 (MIT) is locked in package-lock.json. This module performs
// no filesystem or network access; trusted reader/writer adapters are injected.
// Rich Markdown/Excel/DOCX fidelity remain separately gated.
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MARKDOWN = 100_000;
const MAX_PAGES = 200;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./@ ()+-]{1,1024}\.pdf$/i;
const sha = input => createHash('sha256').update(input).digest('hex');
const validPath = s => typeof s === 'string' && PATH.test(s) && !s.includes('\0');
const assertPdf = bytes => {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 ||
      bytes.length > MAX_BYTES || Buffer.from(bytes.subarray(0,5)).toString() !== '%PDF-')
    throw Error('INVALID_PDF_BYTES');
};
const OPTIONS = Object.freeze({
  Letter: [612,792], A4: [595.28,841.89],
});

function tokenize(markdown) {
  if (typeof markdown !== 'string' ||
      Buffer.byteLength(markdown,'utf8') > MAX_MARKDOWN ||
      markdown.includes('\0')) throw Error('INVALID_MARKDOWN');
  // Supported: headings 1–4, plain paragraphs and simple -/* bullets.
  // Unsupported: code fences, tables, links, images, emphasis, blockquotes,
  // horizontal rules, nested lists, raw HTML and arbitrary Unicode/fonts.
  // This intentionally remains a lossy plain-markdown-subset renderer.
  return markdown.replaceAll('\r\n','\n').split('\n').map(line => {
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) return { level: heading[1].length, text: heading[2] };
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) return { level: 0, bullet:true, text: bullet[1] };
    return { level:0, text:line };
  });
}

export async function renderOfflineMarkdownPdf(markdown, { pageSize = 'Letter',
  title = 'REVREBEL Document', margin = 48 } = {}) {
  if (!Object.hasOwn(OPTIONS,pageSize) ||
      !Number.isFinite(margin) || margin < 24 || margin > 96 ||
      typeof title !== 'string' || title.length > 200)
    throw Error('INVALID_PDF_OPTIONS');
  const lines = tokenize(markdown);
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('REVREBEL offline MCP PDF renderer');
  doc.setProducer('pdf-lib 1.17.1; no browser downloads');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page, y;
  const [width,height] = OPTIONS[pageSize];
  function nextPage() {
    if (doc.getPageCount() >= MAX_PAGES) throw Error('PDF_PAGE_LIMIT');
    page=doc.addPage([width,height]);
    y=height-margin;
  }
  nextPage();
  function draw(line, font, size, indent=0) {
    const x=margin+indent;
    const wrapWidth=width-2*margin-indent;
    const measured = text => {
      try { return font.widthOfTextAtSize(text,size); }
      catch { throw Error('UNSUPPORTED_PDF_GLYPH'); }
    };
    const words=line.split(/\s+/);
    if (!words.length) words.push('');
    let current='';
    const chunks=[];
    for(const word of words) {
      if (!word) continue;
      const candidate=current?current+' '+word:word;
      // Split overlong tokens deterministically without external fonts.
      if(measured(candidate)>wrapWidth && current){
        chunks.push(current);current=word;
      }else current=candidate;
      while (measured(current)>wrapWidth) {
        let count=1;
        while(count<current.length &&
          measured(current.slice(0,count+1))<wrapWidth)count++;
        chunks.push(current.slice(0,count));
        current=current.slice(count);
      }
    }
    if(current)chunks.push(current);
    if(!chunks.length)chunks.push('');
    for (const chunk of chunks) {
      if (y < margin+size+3) nextPage();
      try { page.drawText(chunk, { x, y, size, font, color:rgb(0.10,0.12,0.16) }); }
      catch { throw Error('UNSUPPORTED_PDF_GLYPH'); }
      y-=size*1.38;
    }
  }
  for (const item of lines) {
    if (!item.text) { y-=7;continue; }
    const size = item.level ? [0,19,16,14,12][item.level] : 10.5;
    const font = item.level ? bold : regular;
    const text = item.bullet ? '\u2022  '+item.text : item.text;
    draw(text,font,size,item.bullet?12:0);
    if (item.level) y-=7;
  }
  const bytes=await doc.save({ useObjectStreams:false });
  assertPdf(bytes);
  return Object.freeze({ bytes, pages:doc.getPageCount(), sha256:sha(bytes),
    renderer:'pdf-lib-offline', fidelity:'plain-markdown-subset' });
}
async function loadPdf(bytes) {
  assertPdf(bytes);
  try { return await PDFDocument.load(bytes,{
    ignoreEncryption:false,updateMetadata:false,
  }); } catch { throw Error('INVALID_PDF_DOCUMENT'); }
}
export async function editOfflinePdf({ sourcePdf, operations, readApprovedPdf }) {
  if (!Array.isArray(operations) || operations.length > 64 ||
      typeof readApprovedPdf !== 'function') throw Error('INVALID_PDF_OPERATIONS');
  const doc=await loadPdf(sourcePdf);
  for(const operation of operations) {
    if (!operation || typeof operation !== 'object') throw Error('INVALID_PDF_OPERATIONS');
    if (operation.type==='delete') {
      if (!Array.isArray(operation.pageIndexes) || operation.pageIndexes.length<1 ||
          !operation.pageIndexes.every(i=>Number.isInteger(i)&&i>=0&&i<doc.getPageCount()) ||
          new Set(operation.pageIndexes).size!==operation.pageIndexes.length ||
          operation.pageIndexes.length>=doc.getPageCount())
        throw Error('INVALID_PDF_PAGE_INDEX');
      for (const index of [...operation.pageIndexes].sort((a,b)=>b-a))
        doc.removePage(index);
    } else if (operation.type==='insert') {
      if (!Number.isInteger(operation.pageIndex) || operation.pageIndex<0 ||
          operation.pageIndex>doc.getPageCount() ||
          (typeof operation.markdown==='string')===validPath(operation.sourcePdfPath))
        throw Error('INVALID_PDF_INSERT');
      let insert;
      if (typeof operation.markdown==='string') {
        insert=(await renderOfflineMarkdownPdf(operation.markdown,
          operation.pdfOptions??{})).bytes;
      } else insert=await readApprovedPdf(operation.sourcePdfPath);
      const other=await loadPdf(insert);
      if(doc.getPageCount()+other.getPageCount()>MAX_PAGES)
        throw Error('PDF_PAGE_LIMIT');
      const sourceIndexes=Array.from({length:other.getPageCount()},(_,i)=>i);
      const pages=await doc.copyPages(other,sourceIndexes);
      pages.forEach((page,i)=>doc.insertPage(operation.pageIndex+i,page));
    } else throw Error('INVALID_PDF_OPERATIONS');
  }
  const bytes=await doc.save({useObjectStreams:false});
  assertPdf(bytes);
  return Object.freeze({bytes,pages:doc.getPageCount(),sha256:sha(bytes),
    renderer:'pdf-lib-offline',fidelity:'plain-markdown-subset'});
}
export function createScopedPdfExport({ authority, readApprovedPdf, atomicOutput }) {
  if (typeof authority?.requireGrant!=='function' ||
      typeof readApprovedPdf!=='function' ||
      typeof atomicOutput!=='function')
    throw TypeError('APPROVED_PDF_IO_ADAPTERS_REQUIRED');
  async function writePdf(scope,{ workspaceId, path, content,
    outputPath=path, options={} }) {
    if(typeof workspaceId!=='string' ||
        !validPath(path) || !validPath(outputPath))
      throw Error('INVALID_PDF_PATH');
    authority.requireGrant(scope,'write_pdf',workspaceId,true);
    let result;
    if(typeof content==='string') {
      result=await renderOfflineMarkdownPdf(content, options);
    } else if(Array.isArray(content)) {
      const source=await readApprovedPdf({workspaceId,path});
      result=await editOfflinePdf({
        sourcePdf:source,operations:content,
        readApprovedPdf: name=>readApprovedPdf({workspaceId,path:name}),
      });
    } else throw Error('INVALID_PDF_CONTENT');
    // Only the approved atomic writer may write bytes. It must pin the output
    // directory, refuse symlinks and preserve old bytes on failure.
    await atomicOutput({workspaceId,path:outputPath,bytes:result.bytes,
      sha256:result.sha256,sourcePath:path});
    return Object.freeze({path:outputPath,pages:result.pages,bytes:result.bytes.length,
      sha256:result.sha256,renderer:result.renderer,fidelity:result.fidelity});
  }
  return Object.freeze({writePdf});
}
