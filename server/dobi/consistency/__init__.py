"""一致性引擎（规划文档 §8）。

四类能力，按成本从低到高：

- `l1`    —— 13 条确定性规则，零模型成本（§8.1）
- `l2`    —— 15 维模型审查，带原文证据与「无证据丢弃」硬约束（§8.2）
- `review`—— 7 维可举证质量评审（§8.3）
- `deai`  —— 反 AIGC 去味管线：定位 → 定点修复 → 重跑 L1（§8.4）
- `style` —— 文风仿写：本地确定性基线 + 模型补充（§8.5）
"""

from .deai import DEAI_RULE_NAMES, DeaiResult, detect, strip_ai
from .l1 import (
    CLICHE_PATTERNS,
    RULES,
    TRAIT_CONFLICTS,
    L1Input,
    L1Result,
    check_l1,
    rule_catalog,
    text_ratio,
)
from .l2 import ALL_DIMS, DIMS_P0, DIMS_P1, L2Request, audit_l2
from .review import REVIEW_DIMS, ReviewRequest, review_chapter
from .style import (
    PRESET_SEEDS,
    analyze_style,
    local_metrics,
    merge_profile,
    preset_profile,
    presets,
)

__all__ = [
    # L1
    "L1Input", "L1Result", "check_l1", "rule_catalog", "text_ratio",
    "RULES", "CLICHE_PATTERNS", "TRAIT_CONFLICTS",
    # L2
    "DIMS_P0", "DIMS_P1", "ALL_DIMS", "L2Request", "audit_l2",
    # review
    "REVIEW_DIMS", "ReviewRequest", "review_chapter",
    # deai
    "DeaiResult", "detect", "strip_ai", "DEAI_RULE_NAMES",
    # style
    "local_metrics", "analyze_style", "presets", "preset_profile",
    "merge_profile", "PRESET_SEEDS",
]
