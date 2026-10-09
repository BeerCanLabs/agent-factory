import unittest
from pathlib import Path
from tools.report_triad import generate_triad_report, parse_cartridge_yaml


class TestTriadAndGovernance(unittest.TestCase):
    def test_skills_triad_declaration(self):
        """Verify that cartridge.yaml declares skills with system, secretRef, and hold."""
        cartridge_path = Path("cartridge.yaml")
        self.assertTrue(cartridge_path.exists(), "cartridge.yaml must exist")
        with open(cartridge_path, "r", encoding="utf-8") as f:
            data = parse_cartridge_yaml(f.read())

        skills = data.get("skills", [])
        self.assertTrue(len(skills) > 0, "Agent must declare at least one skill")

        for skill in skills:
            self.assertIn("id", skill, "Every skill must have an id")
            self.assertIn("system", skill, f"Skill {skill.get('id')} must declare its target system")
            self.assertIn("secretRef", skill, f"Skill {skill.get('id')} must declare its secretRef")
            self.assertIn("hold", skill, f"Skill {skill.get('id')} must declare its HITL/hold policy")

    def test_triad_report_generation(self):
        """Verify that the triad report generator produces the standard markdown table."""
        report = generate_triad_report(".")
        self.assertIn("# Triad & Governance Report:", report)
        self.assertIn("| Skill | System | Secret (Requirement) | HITL / Hold | Auth Mechanism / Injection | Purpose |", report)
        self.assertIn("`discord-reply`", report)
        self.assertIn("Discord REST API", report)
        self.assertIn("STARTER_PYTHON_DISCORD_BOT_TOKEN", report)
        self.assertIn("`ops-notify`", report)
        self.assertIn("Webhook Endpoint", report)
        self.assertIn("OPS_NOTIFY_WEBHOOK", report)


if __name__ == "__main__":
    unittest.main()
