// ABR-17 M1: durable submission intents in the canonical job-state directory.
// This journal records external-effect progress, never job admission authority.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';

export function createSubmissionOutbox(jobRoot) {
  const ledger = path.join(jobRoot, 'job-state');
  mkdirSync(ledger, { recursive: true, mode: 0o700 });
  const directory = lstatSync(ledger);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw Error('INVALID_SUBMISSION_LEDGER_DIRECTORY');
  const file = path.join(ledger, 'submission-outbox.sqlite');
  // The authoritative Bridge service owns this directory. Never accept a
  // caller-selected directory or file path from an agent.
  try {
    const existing = lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink()) throw Error('INVALID_SUBMISSION_OUTBOX');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, issue_scope TEXT NOT NULL, head TEXT NOT NULL,
      stage TEXT NOT NULL, pending TEXT, data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS submission_active_issue
      ON submissions(issue_scope) WHERE stage NOT IN ('session_closed','failed','blocked');
    CREATE UNIQUE INDEX IF NOT EXISTS submission_head ON submissions(issue_scope, head);
  `);
  const get = id => {
    const row = db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
    return row ? { id:row.id, stage:row.stage, pending:row.pending,
      ...JSON.parse(row.data) } : null;
  };
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result=work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function claim({id, issueScope, head, data}) {
    return transaction(() => {
      const current=get(id);
      if (current) return {created:false,record:current};
      const same=db.prepare('SELECT id FROM submissions WHERE issue_scope=? AND head=?').get(issueScope,head);
      if (same) throw Error('SUBMISSION_HEAD_ALREADY_RECORDED');
      const active=db.prepare("SELECT id FROM submissions WHERE issue_scope=? AND stage NOT IN ('session_closed','failed','blocked')").get(issueScope);
      if (active) throw Error('ISSUE_SUBMISSION_IN_PROGRESS');
      const previous=db.prepare("SELECT data FROM submissions WHERE issue_scope=? AND stage='session_closed' ORDER BY rowid DESC LIMIT 1").get(issueScope);
      const prior=previous ? JSON.parse(previous.data) : null;
      if (prior && prior.publicationScope !== data.publicationScope)
        throw Error('SUBMISSION_PUBLICATION_SCOPE_CHANGED');
      const stored={...data, previousPr:prior?.github ?? null};
      db.prepare('INSERT INTO submissions(id,issue_scope,head,stage,pending,data) VALUES(?,?,?,?,NULL,?)')
        .run(id,issueScope,head,'received',JSON.stringify(stored));
      return {created:true,record:get(id)};
    });
  }
  function intent(id, expected, next) {
    return transaction(() => {
      const row=get(id);
      if (!row || row.stage !== expected || row.pending !== null) return false;
      return db.prepare('UPDATE submissions SET pending=? WHERE id=? AND stage=? AND pending IS NULL')
        .run(next,id,expected).changes===1;
    });
  }
  function advance(id, expected, next, patch) {
    return transaction(() => {
      const row=db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
      if (!row || row.stage!==expected || row.pending!==next) throw Error('STALE_SUBMISSION_INTENT');
      const data={...JSON.parse(row.data),...patch};
      db.prepare('UPDATE submissions SET stage=?,pending=NULL,data=? WHERE id=?')
        .run(next,JSON.stringify(data),id);
      return get(id);
    });
  }
  return Object.freeze({claim,get,intent,advance,close:()=>db.close()});
}
