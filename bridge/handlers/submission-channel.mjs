// Single-request private inherited IPC channel, not a public HTTP route.
// Launcher must supply the authenticated channel and bind it to the issued
// runner identity. Request data can never choose the token or peer evidence.
export function serveSubmissionChannel(socket,{ingress,coordinator,token,runnerEvidence,timeoutMs=10000}){
  if(!socket?.on||!socket?.end||!ingress?.submitLocal||!coordinator||
     !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('INVALID_SUBMISSION_CHANNEL');
  let chunks=[],size=0,done=false,timer;
  const finish=payload=>{
    if(done)return;
    done=true;clearTimeout(timer);
    socket.removeListener('data',read);
    socket.removeListener('end',onEnd);
    try{socket.end(JSON.stringify(payload)+'\n');}catch{socket.destroy();}
  };
  const reject=()=>finish({ok:false,error:'SUBMISSION_REQUEST_DENIED'});
  const onEnd=()=>reject();
  function read(bytes){
    if(done)return;
    bytes=Buffer.from(bytes);
    size+=bytes.length;
    if(size>12_288)return reject();
    chunks.push(Buffer.from(bytes));
    if(!bytes.includes(10))return;
    const all=Buffer.concat(chunks,size);
    chunks=[];
    if(all.indexOf(10)!==all.length-1)return reject();
    socket.removeListener('data',read);
    socket.removeListener('end',onEnd);
    socket.pause();
    clearTimeout(timer);
    let input;
    try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all.subarray(0,-1)));}
    catch{return reject();}
    // Timeout applies to incomplete input only. An accepted operation uses
    // the coordinator's durable intent and bounded external adapter timeouts.
    Promise.resolve().then(()=>ingress.submitLocal({token,runnerEvidence,input},coordinator))
      .then(value=>finish({ok:true,result:value}),reject);
  }
  socket.on('error',()=>{done=true;clearTimeout(timer);socket.destroy();});
  socket.on('end',onEnd);
  timer=setTimeout(reject,timeoutMs);timer.unref?.();
  socket.on('data',read);
}
