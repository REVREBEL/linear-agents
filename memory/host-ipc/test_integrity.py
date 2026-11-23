"""Reviewed checkout must reject dirty, ignored, untracked and unowned bytes."""
import importlib.util
import pathlib
import types
import unittest
from unittest.mock import patch

import integrity


class IntegrityTests(unittest.TestCase):
    def test_exact_head_and_clean_tracked_and_ignored_state(self):
        head = "a" * 40
        responses = [head,"/trusted","",""]
        def git(argv, **kwargs):
            return types.SimpleNamespace(returncode=0,stdout=responses.pop(0))
        with patch.object(integrity,"trusted_tree",return_value=True):
            self.assertTrue(integrity.reviewed_checkout("/trusted",head,git))
        for dirty_index in range(4):
            responses = [head,"/trusted","",""]
            responses[dirty_index] = ("b"*40 if dirty_index == 0 else
                                      ("/wrong-repository" if dirty_index == 1 else "?? untracked.js"))
            with patch.object(integrity,"trusted_tree",return_value=True):
                self.assertFalse(integrity.reviewed_checkout("/trusted",head,git))

    def test_untrusted_dependency_denies_even_when_git_head_matches(self):
        called = []
        def fake_git(*a,**k):
            called.append(True)
            return types.SimpleNamespace(returncode=0,stdout="a"*40)
        with patch.object(integrity,"trusted_tree",return_value=False):
            self.assertFalse(integrity.reviewed_checkout("/untrusted","a"*40,fake_git))
        self.assertFalse(called)


if __name__=="__main__":
    unittest.main()
