// Shared exclusive lease for managed runtime and offline operator recovery.
// SQLite holds the OS file lock for the lifetime of the connection; crash
// releases it automatically. This is not a job authority or effect journal.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,lstatSync,chmodSync } from 'node:fs';
import path from 'node:path';

export function acquireSubmissionLease(jobsDir){
  const dir=path.join(jobsDir,'job-state');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const st=lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))
    throw Error('SUBMISSION_LEASE_DIRECTORY_UNSAFE');
  const file=path.join(dir,'submission-exclusive.sqlite');
  try{
    const f=lstatSync(file);
    if(!f.isFile()||f.isSymbolicLink()||f.uid!==process.getuid()||(f.mode&0o077))
      throw Error('SUBMISSION_LEASE_FILE_UNSAFE');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  let db;
  try{
    db=new DatabaseSync(file);
    chmodSync(file,0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  }catch{
    db?.close();
    throw Error('SUBMISSION_AUTHORITY_BUSY');
  }
  let held=true;
  return Object.freeze({
    isHeld:()=>held,
    release:()=>{if(held){held=false;try{db.exec('ROLLBACK');}finally{db.close();}}}
  });
}
