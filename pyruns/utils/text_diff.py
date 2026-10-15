"""Bounded line diffs using the mature Myers implementation in Diff Match Patch."""

from __future__ import annotations

import difflib
import io
import time
from collections.abc import Iterable, Iterator
from typing import Literal

MAX_DIFF_BYTES = 256 * 1024
MAX_DIFF_LINES = 4000
_MAX_ALIGNMENT_BYTES = 8 * 1024 * 1024
_MAX_ALIGNMENT_LINES = 500_000
_ALIGNMENT_TIMEOUT_SEC = 0.15
_Opcode = tuple[Literal["equal", "delete", "insert", "replace"], int, int, int, int]


class _OpcodeGroups(difflib.SequenceMatcher):
    """Reuse the public context grouping API with Myers line opcodes."""

    def __init__(self, opcodes: list[_Opcode]) -> None:
        super().__init__()
        self._line_opcodes = opcodes

    def get_opcodes(self) -> list[_Opcode]:
        return self._line_opcodes


def _range(start: int, stop: int) -> str:
    length = stop - start
    beginning = start + 1 if length else start
    return str(beginning) if length == 1 else f"{beginning},{length}"


def _label(value: str) -> str:
    return value.translate({ord(char): f"\\u{ord(char):04x}" for char in "\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029"})


def _trim_context(left: str, right: str, engine) -> tuple[str, str, int]:
    # Trim shared whole lines before tokenization; retain three lines of context.
    common = engine.diff_commonPrefix(left, right)
    start = left.rfind("\n", 0, common) + 1
    for _ in range(3):
        if not start:
            break
        start = left.rfind("\n", 0, start - 1) + 1
    offset = left.count("\n", 0, start)
    left, right = left[start:], right[start:]
    suffix = engine.diff_commonSuffix(left, right)
    end = left.find("\n", len(left) - suffix)
    if end >= 0:
        # The shared suffix may begin inside a line; keep that line too.
        end += 1
        for _ in range(3):
            boundary = left.find("\n", end)
            if boundary < 0:
                end = len(left)
                break
            end = boundary + 1
        removed = len(left) - end
        if removed:
            left, right = left[:end], right[:-removed]
    return left, right, offset


def _unified_lines(left: str, right: str, engine, offset: int) -> Iterator[str]:
    line_counts = [text.count("\n") + int(bool(text) and not text.endswith("\n")) for text in (left, right)]
    if (
        sum(line_counts) > _MAX_ALIGNMENT_LINES
        or len(left.encode("utf-8")) + len(right.encode("utf-8")) > _MAX_ALIGNMENT_BYTES
    ):
        # Keep the change exact even when detailed alignment would cost too much.
        yield f"@@ -{_range(offset, offset + line_counts[0])} +{_range(offset, offset + line_counts[1])} @@\n"
        for sign, text in (("-", left), ("+", right)):
            for line in io.StringIO(text):
                yield sign + line
        return

    encoded_left, encoded_right, lines = engine.diff_linesToChars(left, right)
    chunks = engine.diff_main(
        encoded_left, encoded_right, checklines=False,
        deadline=time.time() + _ALIGNMENT_TIMEOUT_SEC,
    )
    left_lines = [lines[ord(char)] for char in encoded_left]
    right_lines = [lines[ord(char)] for char in encoded_right]
    opcodes: list[_Opcode] = []
    i = j = 0
    for operation, text in chunks:
        count = len(text)
        next_i = i + count if operation <= 0 else i
        next_j = j + count if operation >= 0 else j
        tag = "equal" if operation == 0 else "delete" if operation < 0 else "insert"
        opcodes.append((tag, i, next_i, j, next_j))
        i, j = next_i, next_j
    for group in _OpcodeGroups(opcodes).get_grouped_opcodes(3):
        first, last = group[0], group[-1]
        yield f"@@ -{_range(first[1] + offset, last[2] + offset)} +{_range(first[3] + offset, last[4] + offset)} @@\n"
        for tag, a, b, c, d in group:
            if tag == "equal":
                for line in left_lines[a:b]:
                    yield " " + line
            elif tag == "delete":
                for line in left_lines[a:b]:
                    yield "-" + line
            else:
                for line in right_lines[c:d]:
                    yield "+" + line


def _bounded_output(lines: Iterable[str]) -> tuple[str, bool]:
    parts: list[str] = []
    used_bytes = used_lines = 0
    for line in lines:
        if not line.endswith("\n"):
            line += "\n\\ No newline at end of file\n"
        line_count = line.count("\n")
        if used_lines + line_count > MAX_DIFF_LINES:
            return "".join(parts), True
        remaining = MAX_DIFF_BYTES - used_bytes
        # Bound the temporary encoding too, including for multi-megabyte lines.
        raw = line[:remaining + 1].encode("utf-8")
        if len(raw) > remaining:
            parts.append(raw[:remaining].decode("utf-8", errors="ignore"))
            return "".join(parts), True
        parts.append(line)
        used_bytes += len(raw)
        used_lines += line_count
    return "".join(parts), False


def unified_text_diff(left: str, right: str, *, left_label: str, right_label: str) -> tuple[str, bool]:
    """Return a display diff and explicit truncation; callers compare full inputs."""
    if left == right:
        return "", False
    from diff_match_patch import diff_match_patch

    engine = diff_match_patch()
    # Disable halfMatch's unbounded repetitive-seed scan. The explicit deadline
    # above still bounds Myers bisection and is preserved by recursive calls.
    engine.Diff_Timeout = 0
    left, right, offset = _trim_context(left, right, engine)

    def output() -> Iterator[str]:
        yield f"--- {_label(left_label)}\n"
        yield f"+++ {_label(right_label)}\n"
        yield from _unified_lines(left, right, engine, offset)

    return _bounded_output(output())
