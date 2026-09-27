"""拆书导入层（规划文档 §3.2 ⑫）。

导入已有小说 → 反推结构 → 产出**可编辑的提案**（不直接写真相文件）。
入口：`disassemble.Disassembler`。
"""

from .disassemble import (
    STATE_FILENAME,
    STAGE_TITLES,
    DisassembleResult,
    DisassembleSource,
    Disassembler,
    load,
    split_chapters,
)

__all__ = [
    "Disassembler",
    "DisassembleResult",
    "DisassembleSource",
    "split_chapters",
    "load",
    "STAGE_TITLES",
    "STATE_FILENAME",
]
