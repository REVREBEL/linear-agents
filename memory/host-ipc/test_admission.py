"""Operator pin must match canonical accepted job ledger and task payload."""
import hashlib
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import admission


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="abr59-ledger-")
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)/"repo"
        self.root.mkdir()
        self.ledger = pathlib.Path(self.tmp.name)/"ledger"
        self.ledger.mkdir()
        self.jobkey = "qwen:delivery"
        self.scope = {"tenantId":"tenant","agentId":"qwen",
                      "repositoryId":"REVREBEL/linear-agents","issueId":"ABR-59"}
        self.task = self.root/".linear-agent/projects/demo/inbox/delivery.json"
        self.task.parent.mkdir(parents=True)
        self.task.write_text(json.dumps({"organizationId":"tenant","issueId":"ABR-59",
                                        "agentSessionId":"session"}))
        self.state = {"key":self.jobkey,"agent":"qwen","deliveryId":"delivery",
                      "jobId":"delivery","issueId":"ABR-59","state":"completed",
                      "repositoryRoot":str(self.root),"taskFile":str(self.task),
                      "agentSessionId":"session"}
        self.record = {"jobKey":self.jobkey,
                       "trustedJob":{"jobId":"delivery","scope":self.scope}}
        self.manifest = {"ledgerRoot":str(self.ledger),
                         "repositories":{str(self.root):"REVREBEL/linear-agents"}}
        entry = self.ledger/hashlib.sha256(self.jobkey.encode()).hexdigest()
        entry.mkdir()
        self.statefile = entry/"state.json"
        self.save()
        patcher = patch.object(admission,"LEDGER",str(self.ledger))
        patcher.start()
        self.addCleanup(patcher.stop)

    def save(self):
        self.statefile.write_text(json.dumps(self.state))

    def test_real_admitted_job_and_foreign_agent_or_failed_job(self):
        self.assertTrue(admission.admitted_job(self.manifest,self.record))
        for attr,value in [("agent","other"),("state","failed"),("jobId","foreign"),
                           ("repositoryRoot","/tmp/foreign"),("issueId","ABR-60")]:
            original = self.state[attr]
            self.state[attr] = value
            self.save()
            self.assertFalse(admission.admitted_job(self.manifest,self.record))
            self.state[attr] = original
        self.save()
        self.task.write_text(json.dumps({"organizationId":"other","issueId":"ABR-59",
                                         "agentSessionId":"session"}))
        self.assertFalse(admission.admitted_job(self.manifest,self.record))


if __name__=="__main__":
    unittest.main()
