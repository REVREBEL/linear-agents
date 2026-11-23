"""Durable advisory completion markers cannot imply automatic retry."""
import importlib
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import intent

KEY = "qwen:approved-delivery"
DIGEST = "a" * 64


class IntentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="abr59-intent-")
        self.addCleanup(self.temp.cleanup)
        self.patches = [
            patch.object(intent,"ROOT",str(pathlib.Path(self.temp.name)/"intents")),
            patch.object(intent,"OWNER_UID",os.getuid()),
        ]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_persists_before_ack_and_disallows_automatic_retry(self):
        self.assertTrue(intent.enqueue(KEY,DIGEST))
        self.assertEqual(intent.read(KEY)["state"],"queued")
        self.assertEqual(os.stat(intent.filename(KEY)).st_mode & 0o777,0o600)
        with self.assertRaises(ValueError):
            intent.enqueue(KEY,DIGEST)
        intent.write(KEY,"running",DIGEST)
        intent.recover()  # simulate restart mid native transaction
        self.assertEqual(intent.read(KEY)["state"],"reconcile")
        with self.assertRaises(ValueError):
            intent.enqueue(KEY,DIGEST)
        self.assertEqual(sorted(pathlib.Path(intent.ROOT).iterdir()),
                         [pathlib.Path(intent.filename(KEY))])

    def test_completed_duplicate_does_not_recommit_or_accept_changed_manifest(self):
        self.assertTrue(intent.enqueue(KEY,DIGEST))
        intent.write(KEY,"running",DIGEST)
        intent.write(KEY,"completed",DIGEST)
        self.assertFalse(intent.enqueue(KEY,DIGEST))
        with self.assertRaises(ValueError):
            intent.enqueue(KEY,"b"*64)
        intent.recover()
        self.assertEqual(intent.read(KEY)["state"],"completed")

    def test_unexpected_directory_artifact_denies_recovery(self):
        intent.enqueue(KEY,DIGEST)
        pathlib.Path(intent.ROOT,"stray.tmp").write_text("foreign")
        with self.assertRaises(ValueError):
            intent.recover()


if __name__=="__main__":
    unittest.main()
