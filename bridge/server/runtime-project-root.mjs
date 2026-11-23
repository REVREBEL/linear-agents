import path from "node:path";

/** Keep source imports sealed while runtime jobs and agent workspaces stay writable. */
export function resolveBridgeProjectDirectory(sourceProjectDir, override){
  if(typeof sourceProjectDir!=="string"||!path.isAbsolute(sourceProjectDir)||
     path.normalize(sourceProjectDir)!==sourceProjectDir)throw Error("Invalid source project directory");
  if(override===undefined||override==="")return sourceProjectDir;
  if(typeof override!=="string"||!path.isAbsolute(override)||
     path.normalize(override)!==override||
     /[\x00-\x1f\x7f]/.test(override)||override.includes("/../")||
     override.includes("/./")||override.endsWith("/")||override==="/")throw Error("Invalid runtime project directory");
  return override;
}
