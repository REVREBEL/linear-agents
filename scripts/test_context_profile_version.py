"""ABR-65: guard against silently adding research-entry profileVersion."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/validate-context-blueprint.py"
SPEC = importlib.util.spec_from_file_location("context_blueprint_validator", SCRIPT)
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)
PROMOTION_SCRIPT = ROOT / "scripts/review-research-promotion.py"
PROMOTION_SPEC = importlib.util.spec_from_file_location(
    "research_promotion_validator", PROMOTION_SCRIPT
)
promotion = importlib.util.module_from_spec(PROMOTION_SPEC)
PROMOTION_SPEC.loader.exec_module(promotion)
SCHEMA = json.loads(
    (ROOT / "templates/context/agent-profile.entry.schema.json").read_text(encoding="utf-8")
)
PROFILE = yaml.safe_load(
    (ROOT / "templates/context/agent-profile.v2.template.yaml").read_text(encoding="utf-8")
)


class ProfileVersionContractTests(unittest.TestCase):
    def test_current_research_contract_has_no_profile_version(self):
        self.assertNotIn("profileVersion", SCHEMA["properties"])
        validator.guard_research_schema_version(SCHEMA)
        validator.validate_research_profile(PROFILE, SCHEMA, "valid profile")

    def test_undeclared_profile_version_rejected_even_if_schema_allows_extras(self):
        changed = {**PROFILE, "profileVersion": 1}
        self.assertTrue(validator.Draft202012Validator(SCHEMA).is_valid(changed))
        with self.assertRaisesRegex(ValueError, "undeclared profileVersion"):
            validator.validate_research_profile(changed, SCHEMA, "candidate")

    def test_adding_schema_field_requires_separate_reviewed_migration(self):
        changed_schema = copy.deepcopy(SCHEMA)
        changed_schema["properties"]["profileVersion"] = {"type": "integer"}
        with self.assertRaisesRegex(ValueError, "separately reviewed schema/migration"):
            validator.guard_research_schema_version(changed_schema)

    def test_proposal_compiler_also_rejects_unreviewed_profile_version(self):
        changed = {**PROFILE, "profileVersion": 1}
        with self.assertRaisesRegex(ValueError, "profileVersion requires"):
            promotion.require_unversioned_research(changed, SCHEMA)
        changed_schema = copy.deepcopy(SCHEMA)
        changed_schema["properties"]["profileVersion"] = {"type": "integer"}
        with self.assertRaisesRegex(ValueError, "profileVersion requires"):
            promotion.require_unversioned_research(PROFILE, changed_schema)

    def test_catalog_version_is_independent_and_allowed(self):
        catalog = yaml.safe_load(
            (ROOT / "agents/agent-registry.yaml").read_text(encoding="utf-8")
        )
        self.assertEqual(catalog["version"], "1.0.0")
        self.assertNotIn("profileVersion", catalog)
        for item in catalog["agents"]:
            validator.validate_research_profile(item, SCHEMA, item["id"])


if __name__ == "__main__":
    unittest.main()
