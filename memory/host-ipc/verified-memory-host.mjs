/** Install only as /etc/agent-bridge/verified-memory-host.mjs (root:root
 * 0644). This client has NO signing, Linear, GitHub, DB or privilege APIs. */
import net from "node:net";
const SOCKET="/run/bridge-memory-authority/bridge.sock";
function deny(){return Error("protected memory host unavailable");}
function call(payload,timeoutMs=1500){
  const json=JSON.stringify(payload)+"\n";
  if(Buffer.byteLength(json)>2048)throw deny();
  return new Promise((resolve,reject)=>{
    let finished=false,total=0,parts=[];
    const client=net.createConnection({path:SOCKET,allowHalfOpen:false});
    const timer=setTimeout(()=>finish(null),timeoutMs);
    function finish(value){
      if(finished)return;
      finished=true;clearTimeout(timer);client.destroy();
      if(value===null)reject(deny());else resolve(value);
    }
    client.on("connect",()=>client.write(json));
    client.on("data",chunk=>{
      total+=chunk.length;
      if(total>12288){finish(null);return;}
      parts.push(Buffer.from(chunk));
      if(chunk[chunk.length-1]!==10)return;
      try{
        const data=Buffer.concat(parts,total).toString("utf8");
        if(!data.endsWith("\n")||data.indexOf("\n")!==data.length-1)throw deny();
        const answer=JSON.parse(data);
        if(answer?.ok!==true)throw deny();
        finish(answer);
      }catch{finish(null);}
    });
    client.on("error",()=>finish(null));
    client.on("end",()=>{if(!finished)finish(null);});
  });
}
export async function createVerifiedMemoryBridgeHost(){
  return Object.freeze({
    async repositoryIdForRoot(repositoryRoot){
      if(typeof repositoryRoot!=="string"||!repositoryRoot.startsWith("/")||
         repositoryRoot.length>512)throw deny();
      const reply=await call({op:"repo",repositoryRoot});
      if(typeof reply.repositoryId!=="string")throw deny();
      return reply.repositoryId;
    },
    async getApprovedScopedRecall({tenantId,agentId,repositoryRoot,issueId,jobKey}={}){
      const reply=await call({op:"recall",tenantId,agentId,repositoryRoot,issueId,jobKey},11000);
      if(!reply.result||typeof reply.result!=="object")throw deny();
      return reply.result;
    },
    async notifyIssueCompleted({issueId}={}){
      const reply=await call({op:"complete",issueId});
      if(reply.accepted!==true)throw deny();
    },
  });
}
