"""Pydantic schemas for Trigger Presets.

Cycle 20260507 redesign — promotes prompts to a top-level reusable
library so the editor can present them as a separate workspace from
situations:

  Prompt    =  natural-language text (re-usable). Just content +
                identity. No tags, no metadata.

  Category  =  "발화 상황" — when this fires (conditions) + which
                prompts it references (with per-reference weight).
                One prompt can be referenced by many categories;
                each reference carries its own weight in that
                situation.

Runtime semantics::

  ① find every Category whose conditions hold under the current
     scenario (consec, sub-worker, time, cooldown)
  ② weighted roulette across matching categories (Category.weight)
     to pick a single situation
  ③ weighted roulette across that category's prompt_refs to pick a
     prompt by id
  ④ resolve the prompt id against the manifest's prompt library and
     render: ``[KIND_TRIGGER:cat_id] [autonomous_signal: …] {content}``
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


# ── Runtime sub-models ────────────────────────────────────────────


class TriggerTiming(BaseModel):
    """Idle-window timing knobs for the trigger loop."""

    base_idle_seconds: float = Field(120.0, ge=5.0)
    max_idle_seconds: float = Field(3600.0, ge=5.0)
    tick_interval_seconds: float = Field(30.0, ge=5.0)
    sub_worker_working_cooldown_seconds: float = Field(90.0, ge=0.0)
    adaptive_scale_triggers: int = Field(20, ge=1)

    @model_validator(mode="after")
    def _enforce_max_ge_base(self) -> "TriggerTiming":
        if self.max_idle_seconds < self.base_idle_seconds:
            raise ValueError(
                "max_idle_seconds must be >= base_idle_seconds"
            )
        return self


class TimeBoundaries(BaseModel):
    """Hour-of-day boundaries (KST) for ``time_window`` conditions."""

    morning_start: int = Field(6, ge=0, le=23)
    afternoon_start: int = Field(12, ge=0, le=23)
    evening_start: int = Field(18, ge=0, le=23)
    night_start: int = Field(22, ge=0, le=23)


TriggerKind = Literal["thinking", "activity"]
TimeWindow = Literal["morning", "afternoon", "evening", "night"]


# ── Prompt library ────────────────────────────────────────────────


class TriggerPrompt(BaseModel):
    """One re-usable natural-language prompt.

    Stored in the manifest's top-level ``prompts`` list and referenced
    from categories via ``prompt_refs``. Editor surfaces this in the
    "프롬프트" section so the operator manages prompt content separately
    from situation logic.

    ``content`` keys are locale codes (``en``, ``ko``, …); each value
    is the **raw natural language** — no ``[THINKING_TRIGGER:…]`` tag,
    no ``[autonomous_signal: …]`` prefix. Those are constructed from
    the parent category's metadata at fire time.
    """

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(
        "",
        max_length=120,
        description="Optional human-friendly label for the prompt list view.",
    )
    content: Dict[str, str] = Field(
        default_factory=dict,
        description="locale → natural-language text",
    )
    tags: List[str] = Field(
        default_factory=list,
        description=(
            "Free-form tags for filtering / organising the prompt "
            "library. Not consumed by the runtime."
        ),
    )

    @model_validator(mode="after")
    def _trim_content(self) -> "TriggerPrompt":
        clean: Dict[str, str] = {}
        for locale, value in self.content.items():
            text = str(value).strip()
            if text:
                clean[locale] = text
        self.content = clean
        return self


class PromptRef(BaseModel):
    """Reference from a category to a prompt + per-situation weight.

    ``weight`` is the chance of *this* prompt firing within the
    referencing category once the category is picked (stage-2 of the
    two-stage roulette). Same prompt referenced by another category
    can carry a different weight there.
    """

    prompt_id: str = Field(..., min_length=1, max_length=64)
    weight: float = Field(1.0, ge=0.0)


# ── Category ──────────────────────────────────────────────────────


class TriggerCategory(BaseModel):
    """One firable situation.

    A category bundles three orthogonal concerns:

      • **Identity** — id (used in the auto-generated tag), label, kind
      • **Conditions** — when this situation applies. consec range,
        sub-worker state, time window, per-category cooldown.
      • **Prompt refs** — which prompts in the manifest's library this
        situation can fire, and at what within-category weight.
    """

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field("", max_length=120)
    kind: TriggerKind = "thinking"

    weight: float = Field(1.0, ge=0.0)

    consec_min: int = Field(0, ge=0)
    consec_max: Optional[int] = Field(None, ge=0)
    requires_sub_worker_busy: bool = False
    requires_sub_worker_idle: bool = False
    # When true, this situation only fires while the user is actively sharing
    # their screen (a frame was uploaded recently). The runtime attaches the
    # live screen frame to the turn so the persona reacts to what's on screen.
    requires_screen_active: bool = False
    time_window: Optional[TimeWindow] = None
    cooldown_seconds: float = Field(0.0, ge=0.0)

    autonomous_signal: str = Field(
        "",
        description=(
            "Optional content to inject as ``[autonomous_signal: …]``. "
            "Empty = omit the block. Internal hint for the agent — "
            "operators rarely need to touch this."
        ),
    )

    prompt_refs: List[PromptRef] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_consec_range(self) -> "TriggerCategory":
        if (
            self.consec_max is not None
            and self.consec_max < self.consec_min
        ):
            raise ValueError(
                f"category {self.id!r}: consec_max ({self.consec_max}) "
                f"< consec_min ({self.consec_min})"
            )
        return self


# ── Manifest ──────────────────────────────────────────────────────


class TriggerPresetManifest(BaseModel):
    """Full body of a trigger preset.

    Two-tier model:

      • ``prompts`` — top-level library. The editor manages these in
        the "프롬프트" section.
      • ``categories`` — situations that reference prompts. The editor
        manages these in the "상황" section.
    """

    enabled: bool = True
    timing: TriggerTiming = Field(default_factory=TriggerTiming)
    time_boundaries: TimeBoundaries = Field(default_factory=TimeBoundaries)
    prompts: List[TriggerPrompt] = Field(default_factory=list)
    categories: List[TriggerCategory] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate(self) -> "TriggerPresetManifest":
        # Unique ids
        cat_ids = [c.id for c in self.categories]
        if len(cat_ids) != len(set(cat_ids)):
            raise ValueError("category ids must be unique")
        prompt_ids = [p.id for p in self.prompts]
        if len(prompt_ids) != len(set(prompt_ids)):
            raise ValueError("prompt ids must be unique")

        # Every prompt_ref must resolve to a known prompt id.
        known = set(prompt_ids)
        for cat in self.categories:
            for ref in cat.prompt_refs:
                if ref.prompt_id not in known:
                    raise ValueError(
                        f"category {cat.id!r} references unknown "
                        f"prompt_id={ref.prompt_id!r}"
                    )
        return self


# ── Persisted record ──────────────────────────────────────────────


class TriggerPresetRecord(BaseModel):
    id: str
    name: str
    description: str = ""
    tags: List[str] = Field(default_factory=list)
    created_at: str
    updated_at: str
    manifest: TriggerPresetManifest


# ── Controller request / response models ──────────────────────────


class CreateTriggerPresetRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str = ""
    tags: List[str] = Field(default_factory=list)
    manifest: Optional[TriggerPresetManifest] = None
    clone_from: Optional[str] = None

    @model_validator(mode="after")
    def _exclusive_seed(self) -> "CreateTriggerPresetRequest":
        if self.manifest is not None and self.clone_from:
            raise ValueError(
                "Provide either ``manifest`` or ``clone_from``, not both."
            )
        return self


class UpdateTriggerPresetRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    description: Optional[str] = None
    tags: Optional[List[str]] = None


class ReplaceManifestRequest(BaseModel):
    manifest: TriggerPresetManifest


class DuplicateTriggerPresetRequest(BaseModel):
    new_name: str = Field(..., min_length=1, max_length=120)


class TriggerPresetSummaryResponse(BaseModel):
    id: str
    name: str
    description: str
    tags: List[str]
    created_at: str
    updated_at: str
    enabled: bool
    category_count: int
    prompt_count: int
    #: True for the in-code bundled default preset Geny seeds on boot. The
    #: UI lists these under a separate "기본 프리셋" section.
    is_bundled: bool = False


class TriggerPresetListResponse(BaseModel):
    presets: List[TriggerPresetSummaryResponse]
    #: The preset id currently DESIGNATED as the default (used by sessions with
    #: no explicit/env-mapped preset). Lets the UI badge "기본값".
    default_preset_id: str = "default"


class TriggerPresetDetailResponse(BaseModel):
    id: str
    name: str
    description: str
    tags: List[str]
    created_at: str
    updated_at: str
    manifest: TriggerPresetManifest


class CreateTriggerPresetResponse(BaseModel):
    id: str


# ── Helpers ───────────────────────────────────────────────────────


def render_prompt(
    category: TriggerCategory,
    content: str,
    *,
    time_context: Optional[str] = None,
) -> str:
    """Render a fully-formed prompt string from a category + content.

    The runtime calls this *exactly once* per fire. Operators don't
    have to think about the tag format — only the natural language —
    because every prompt that goes out is constructed here::

        [{KIND}_TRIGGER:{id}] [autonomous_signal: {signal}] [time_context: {tc}] {content}

    The ``autonomous_signal`` chunk is omitted when the category leaves
    that field empty. ``time_context`` (e.g. ``일요일 아침, 09:51 KST``) is an
    explicit current-time anchor so the persona never guesses the time of day.
    """
    kind_token = (
        "ACTIVITY_TRIGGER" if category.kind == "activity" else "THINKING_TRIGGER"
    )
    head = f"[{kind_token}:{category.id}]"
    parts: List[str] = [head]
    signal = (category.autonomous_signal or "").strip()
    if signal:
        parts.append(f"[autonomous_signal: {signal}]")
    if time_context and time_context.strip():
        parts.append(f"[time_context: {time_context.strip()}]")
    parts.append(content.strip())
    return " ".join(parts)


__all__ = [
    "PromptRef",
    "TimeBoundaries",
    "TimeWindow",
    "TriggerCategory",
    "TriggerKind",
    "TriggerPresetManifest",
    "TriggerPresetRecord",
    "TriggerPrompt",
    "TriggerTiming",
    # Controller
    "CreateTriggerPresetRequest",
    "CreateTriggerPresetResponse",
    "DuplicateTriggerPresetRequest",
    "ReplaceManifestRequest",
    "TriggerPresetDetailResponse",
    "TriggerPresetListResponse",
    "TriggerPresetSummaryResponse",
    "UpdateTriggerPresetRequest",
    "render_prompt",
]
