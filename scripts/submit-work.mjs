#!/usr/bin/env node
// ABR-17 M2: inherited private duplex FD 3, supplied by the trusted launcher.
// No URL, credential, job identity or network target is accepted from argv/env.
import net from 'node:net';
const argv=process.argv.slice(2);
const outcome=['--failed','--blocked'].includes(argv[0])?argv.shift().slice(2):null;
const [issueId,summary,...extra]=argv;
function fail(){process.stderr.write('Submission unavailable or denied.\n');process.exitCode=1;}
if(extra.length||typeof issueId!=='string'||!issueId||
   typeof summary!=='string'||!summary.trim()||
   Buffer.byteLength(issueId)>128||Buffer.byteLength(summary)>8192){
  process.stderr.write('Usage: submit-work [--failed|--blocked] <issue-id> <summary>\n');
  process.exitCode=2;
}else{
  let socket;
  try{
    socket=new net.Socket({fd:3,readable:true,writable:true});
    socket.write(JSON.stringify({issueId,summary,...(outcome?{outcome}:{})})+'\n');
    let total=0;const chunks=[];
    for await(const chunk of socket){
      total+=chunk.length;
      if(total>16384)throw Error('oversize');
      chunks.push(chunk);
    }
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result?.ok!==true)fail();
    else {process.stdout.write(JSON.stringify(result.result)+'\n');
      if(!['session_closed','failed','blocked'].includes(result.result?.stage)||result.result?.pending)process.exitCode=3;}
  }catch{fail();}finally{socket?.destroy();}
}
