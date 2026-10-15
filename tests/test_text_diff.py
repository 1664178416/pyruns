"""Readable, applicable line diffs and bounded handling of adversarial inputs."""

import shutil
import subprocess

import pytest

from pyruns.utils import text_diff
from pyruns.utils.process_utils import hidden_subprocess_kwargs


@pytest.mark.parametrize("left,right", [
    ("", "added\n"), ("removed\n", ""),
    ("before\n", "after\n"), ("same\n", "same"),
    ("echo a\u2028b\u0085c\rvalue\n", "echo changed\u2028b\u0085c\rvalue\n"),
    ("".join(f"line {i}\n" for i in range(100)),
     "".join(f"line {i}\n" if i not in {20, 80} else "changed\n" for i in range(100))),
])
def test_unified_diff_applies_exactly_with_git(tmp_path, left, right):
    diff, truncated = text_diff.unified_text_diff(left, right, left_label="a/input.sh", right_label="b/input.sh")
    assert not truncated
    _assert_diff_applies(tmp_path, left, right, diff)


def _assert_diff_applies(tmp_path, left, right, diff):
    git = shutil.which("git")
    if not git:
        pytest.skip("Git unavailable for independent patch validation")
    path = tmp_path / "input.sh"
    path.write_bytes(left.encode("utf-8"))
    result = subprocess.run(
        [git, "-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"],
        input=diff.encode("utf-8"), cwd=tmp_path, capture_output=True,
        **hidden_subprocess_kwargs(),
    )
    assert result.returncode == 0, (result.stderr, diff)
    assert path.read_bytes() == right.encode("utf-8")


def test_repetitive_rotation_retains_a_small_precise_diff():
    lines = [f"echo section_{i % 200:03d}\n" for i in range(64_000)]
    left, right = "".join(lines), "".join(lines[1:] + lines[:1])
    diff, truncated = text_diff.unified_text_diff(left, right, left_label="a", right_label="b")
    assert not truncated and len(diff) < 1000
    assert "-echo section_000\n" in diff and "+echo section_000\n" in diff


def test_changed_ends_with_repetitive_middle_skip_half_match_and_keep_deadline(monkeypatch, tmp_path):
    from diff_match_patch import diff_match_patch

    original_half_match = diff_match_patch.diff_halfMatch
    original_bisect = diff_match_patch.diff_bisect
    stages = set()

    def checked_half_match(engine, left, right):
        # Fail before entering the unbounded seed scan if it becomes enabled.
        assert engine.Diff_Timeout == 0
        stages.add("half_match_disabled")
        result = original_half_match(engine, left, right)
        assert result is None
        return result

    def checked_bisect(engine, left, right, deadline):
        assert deadline == 1000 + text_diff._ALIGNMENT_TIMEOUT_SEC
        stages.add("bounded_bisect")
        return original_bisect(engine, left, right, deadline)

    monkeypatch.setattr(text_diff.time, "time", lambda: 1000)
    monkeypatch.setattr(diff_match_patch, "diff_halfMatch", checked_half_match)
    monkeypatch.setattr(diff_match_patch, "diff_bisect", checked_bisect)
    middle = "repeat\n" * 100_000
    left, right = "left-head\n" + middle + "left-tail\n", "right-head\n" + middle + "right-tail\n"
    diff, truncated = text_diff.unified_text_diff(left, right, left_label="a/input.sh", right_label="b/input.sh")
    assert stages == {"half_match_disabled", "bounded_bisect"}
    assert not truncated and len(diff) < 1000
    _assert_diff_applies(tmp_path, left, right, diff)


def test_alignment_budget_fallback_still_applies_exactly(monkeypatch, tmp_path):
    monkeypatch.setattr(text_diff, "_MAX_ALIGNMENT_LINES", 1)
    left, right = "before\nsame\ntail", "after\nsame\nchanged\n"
    diff, truncated = text_diff.unified_text_diff(left, right, left_label="a/input.sh", right_label="b/input.sh")
    assert not truncated
    assert "-same\n" in diff and "+same\n" in diff
    _assert_diff_applies(tmp_path, left, right, diff)


def test_large_shared_context_does_not_consume_alignment_budget(monkeypatch):
    monkeypatch.setattr(text_diff, "_MAX_ALIGNMENT_LINES", 20)
    common = "same\n" * 10_000
    diff, truncated = text_diff.unified_text_diff(
        common + "before\n" + common, common + "after\n" + common,
        left_label="a", right_label="b",
    )
    assert not truncated and len(diff) < 500
    assert "@@ -9998,7 +9998,7 @@" in diff


@pytest.mark.parametrize("left,right", [
    ("old\n" * 10_000, "new\n" * 10_000),
    ("测" * 200_000 + "\n", "changed\n"),
], ids=["many_changed_lines", "long_unicode_line"])
def test_diff_output_has_explicit_utf8_and_line_limits(left, right):
    diff, truncated = text_diff.unified_text_diff(left, right, left_label="a", right_label="b")
    assert truncated
    assert len(diff.encode("utf-8")) <= text_diff.MAX_DIFF_BYTES
    assert diff.count("\n") <= text_diff.MAX_DIFF_LINES


def test_oversized_alignment_is_bounded_before_entering_the_engine(monkeypatch):
    from diff_match_patch import diff_match_patch

    monkeypatch.setattr(diff_match_patch, "diff_main", lambda *a, **kw: pytest.fail("alignment exceeds budget"))
    diff, truncated = text_diff.unified_text_diff(
        "old\n" * 300_000, "new\n" * 300_000, left_label="a", right_label="b",
    )
    assert truncated and diff.count("\n") <= text_diff.MAX_DIFF_LINES


def test_unicode_separators_remain_content_and_cannot_split_labels():
    diff, truncated = text_diff.unified_text_diff(
        "echo a\u2028b\n", "echo a\u2028c\n", left_label="旧\u2028+++fake", right_label="new",
    )
    assert not truncated and "No newline" not in diff
    assert diff.startswith("--- 旧\\u2028+++fake\n+++ new\n")
    assert "-echo a\u2028b\n+echo a\u2028c\n" in diff
