import {discoverLinearOAuthIdentity} from "../linear-oauth-lifecycle.mjs";
const root="/var/lib/bridge-memory-authority";
try{
  if(process.getuid?.()!==0||process.argv.length!==3)throw Error("operator invocation required");
  const result=await discoverLinearOAuthIdentity({root,expectedWorkspaceId:process.argv[2]});
  console.log(JSON.stringify(result));
}catch{
  console.error(JSON.stringify({linearOAuthIdentity:"denied"}));
  process.exitCode=1;
}
