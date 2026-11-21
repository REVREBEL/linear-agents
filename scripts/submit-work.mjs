#!/usr/bin/env node
// ABR-17 M2: inherited private duplex FD 3, supplied by the trusted launcher.
// No URL, credential, job identity or network target is accepted from argv/env.
import net from 'node:net';
const [issueId,summary,...extra]=process.argv.slice(2);
function fail(){process.stderr.write('Submission unavailable or denied.\n');process.exitCode=1;}
if(extra.length||typeof issueId!=='string'||!issueId||
   typeof summary!=='string'||!summary.trim()||
   Buffer.byteLength(issueId)>128||Buffer.byteLength(summary)>8192){
  process.stderr.write('Usage: submit-work <issue-id> <summary>\n');
  process.exitCode=2;
}else{
  let socket;
  try{
    socket=new net.Socket({fd:3,readable:true,writable:true});
    socket.write(JSON.stringify({issueId,summary})+'\n');
    let total=0;const chunks=[];
    for await(const chunk of socket){
      total+=chunk.length;
      if(total>16384)throw Error('oversize');
      chunks.push(chunk);
    }
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result?.ok!==true)fail();
    else process.stdout.write(JSON.stringify(result.result)+'\n');
  }catch{fail();}finally{socket?.destroy();}
}
