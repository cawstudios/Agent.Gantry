from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / ".codex" / "scripts" / "check_runtime_truth.py"


class RuntimeTruthScriptTests(unittest.TestCase):
    def test_runtime_truth_script_passes_for_repo(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("Runtime truth checks passed", result.stdout)

    def test_runtime_truth_fails_when_renderer_memory_fragment_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            shutil.copytree(REPO_ROOT, root, ignore=shutil.ignore_patterns(".git", "node_modules", "dist"))
            renderer = (
                root
                / "apps"
                / "core"
                / "src"
                / "config"
                / "settings"
                / "runtime-settings-renderer.ts"
            )
            renderer.write_text(
                renderer.read_text(encoding="utf-8").replace("'memory:',", "'memor:',"),
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, str(root / ".codex" / "scripts" / "check_runtime_truth.py")],
                cwd=root,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("missing canonical memory fragment `memory:`", result.stdout)

    def test_runtime_truth_fails_when_runtime_settings_render_features(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            shutil.copytree(REPO_ROOT, root, ignore=shutil.ignore_patterns(".git", "node_modules", "dist"))
            renderer = (
                root
                / "apps"
                / "core"
                / "src"
                / "config"
                / "settings"
                / "runtime-settings-renderer.ts"
            )
            renderer.write_text(
                renderer.read_text(encoding="utf-8") + "\nconst stale = 'features:';\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, str(root / ".codex" / "scripts" / "check_runtime_truth.py")],
                cwd=root,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("must not render features settings", result.stdout)


if __name__ == "__main__":
    unittest.main()
