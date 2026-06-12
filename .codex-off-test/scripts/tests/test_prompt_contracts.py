from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text()


class PromptContractTests(unittest.TestCase):
    def test_implementer_prompt_requires_changed_behavior_tests(self) -> None:
        prompt = read_text("prompts/implementer.md")
        self.assertIn("direct automated test", prompt)
        self.assertIn("Bug fixes must add a regression test", prompt)

    def test_implementer_prompt_requires_edge_case_and_bug_checks(self) -> None:
        prompt = read_text("prompts/implementer.md")
        self.assertIn("edge cases", prompt)
        self.assertIn("bug check", prompt)
        self.assertIn("timers, shutdown, and process exit behavior", prompt)

    def test_self_check_requires_edge_case_accounting(self) -> None:
        prompt = read_text("prompts/self-check.md")
        self.assertIn("Which edge cases did you check?", prompt)
        self.assertIn("regression test", prompt)

    def test_planner_requires_surface_impact_matrix(self) -> None:
        prompt = read_text("prompts/planner.md")
        agent_contract = read_text("agents/planner-high.toml")
        for text in (prompt, agent_contract):
            self.assertIn("Surface Impact Matrix", text)
            self.assertIn("settings.yaml", text)
            self.assertIn("Postgres/runtime projection", text)
            self.assertIn("Gantry MCP tools/admin skill", text)
            self.assertIn("Unchanged by design", text)

    def test_self_check_requires_matrix_and_cleanup_accounting(self) -> None:
        prompt = read_text("prompts/self-check.md")
        self.assertIn("Surface Impact Matrix", prompt)
        self.assertIn("cleanup search", prompt)
        self.assertIn("no-legacy", prompt)

    def test_automated_tester_prompt_requires_regression_and_edge_cases(self) -> None:
        prompt = read_text("prompts/tester-automated.md")
        self.assertIn("regression coverage for bug fixes", prompt)
        self.assertIn("edge cases and failure paths", prompt)

    def test_automated_tester_agent_contract_matches_policy(self) -> None:
        agent_contract = read_text("agents/automated-tester.toml")
        self.assertIn("direct automated test coverage", agent_contract)
        self.assertIn("regression coverage for bug fixes", agent_contract)
        self.assertIn("edge cases and failure paths", agent_contract)
        self.assertIn("Do not optimize for repo-wide coverage percentages", agent_contract)

    def test_codex_agents_guidance_captures_prompt_hygiene_rules(self) -> None:
        guidance = read_text("AGENTS.md")
        self.assertIn("changed-behavior tests, regression coverage, edge-case review, and bug finding", guidance)
        self.assertIn("Keep hook behavior adaptive for local work", guidance)
        self.assertIn("add or update tests under `.codex/scripts/tests/`", guidance)
        self.assertIn("Convert repeated corrections into compact skills", guidance)

    def test_prompt_policy_rejects_blanket_coverage_targets(self) -> None:
        implementer = read_text("prompts/implementer.md")
        tester = read_text("prompts/tester-automated.md")
        self.assertIn("Do not chase repo-wide coverage percentages", implementer)
        self.assertIn("Do not optimize for blanket coverage percentages", tester)

    def test_stage_playbook_still_keeps_pr_ready_gate(self) -> None:
        playbook = read_text("scripts/stage_playbook.py")
        self.assertIn('"pr-ready"', playbook)
        self.assertIn('"reviewing"', playbook)
        self.assertIn('"functional-check"', playbook)
        self.assertIn('"quality-reviewer"', playbook)
        self.assertIn('"performance-reviewer"', playbook)
        self.assertIn('"security-reviewer"', playbook)
        self.assertIn('"automated-tester"', playbook)
        self.assertIn('"functional-checker"', playbook)
        self.assertIn("python3 .codex/scripts/validate_work.py", playbook)

    def test_reviewer_prompts_require_holistic_architecture_review(self) -> None:
        for relative_path in [
            "prompts/review-orchestrator.md",
            "prompts/reviewer-quality.md",
            "prompts/reviewer-security.md",
            "prompts/reviewer-performance.md",
            "agents/quality-reviewer.toml",
            "agents/security-reviewer.toml",
            "agents/performance-reviewer.toml",
        ]:
            prompt = read_text(relative_path)
            self.assertIn("holistic architecture", prompt, relative_path)
            self.assertIn("literal user request", prompt, relative_path)
            self.assertIn("provider boundaries", prompt, relative_path)
            self.assertIn("configuration ownership", prompt, relative_path)

    def test_surface_impact_reviewer_checks_matrix_and_cleanup(self) -> None:
        prompt = read_text("agents/surface-impact-reviewer.toml")
        self.assertIn("Surface Impact Matrix", prompt)
        self.assertIn("source-of-truth", prompt)
        self.assertIn("no-legacy cleanup evidence", prompt)
        self.assertIn("verification commands", prompt)

    def test_memory_lessons_curator_stays_read_only_and_checks_staleness(self) -> None:
        prompt = read_text("agents/memory-lessons-curator.toml")
        self.assertIn("Stay read-only", prompt)
        self.assertIn("Do not edit memory files", prompt)
        self.assertIn("may be stale", prompt)
        self.assertIn("over-fragmentation risk", prompt)

    def test_pr_ready_prompt_allows_new_scope_handoff(self) -> None:
        prompt = read_text("prompts/pr-ready.md")
        self.assertIn("do not block on the current PR-ready loop", prompt)
        self.assertIn("start a new factory run with intake", prompt)


if __name__ == "__main__":
    unittest.main()
