"""Policy copied from Project Geny thinking_trigger.py. Only host lookups are adapted.
See docs/mate-proactive-parity.md for source mapping and parity tests.
"""
from __future__ import annotations
import math, random, time
from typing import List, Tuple, Optional
from .schemas import TriggerCategory, TriggerPresetManifest, TriggerPrompt, PromptRef, render_prompt
from .defaults import default_manifest
def _category_eligible(
    category: TriggerCategory,
    *,
    consec: int,
    sub_worker_busy: bool,
    sub_worker_linked: bool,
    time_window: str,
    last_fire_at: float,
    now: float,
    screen_active: bool = False,
) -> bool:
    """Mirror of the FE simulator — condition gate for one category."""
    if consec < category.consec_min:
        return False
    if category.consec_max is not None and consec > category.consec_max:
        return False
    if category.requires_sub_worker_busy and not sub_worker_busy:
        return False
    if category.requires_sub_worker_idle:
        if not sub_worker_linked or sub_worker_busy:
            return False
    if getattr(category, "requires_screen_active", False) and not screen_active:
        return False
    if (
        category.time_window is not None
        and category.time_window != time_window
    ):
        return False
    if category.cooldown_seconds and category.cooldown_seconds > 0:
        if (now - last_fire_at) < category.cooldown_seconds:
            return False
    return True

def _resolve_time_window(
    manifest: TriggerPresetManifest, hour: int
) -> str:
    bounds = manifest.time_boundaries
    if bounds.morning_start <= hour < bounds.afternoon_start:
        return "morning"
    if bounds.afternoon_start <= hour < bounds.evening_start:
        return "afternoon"
    if bounds.evening_start <= hour < bounds.night_start:
        return "evening"
    return "night"

def _weighted_pick(items: List[Tuple[float, object]]) -> Optional[object]:
    """Roulette across (weight, item) tuples. Returns None if all zero."""
    total = sum(w for w, _ in items if w > 0)
    if total <= 0:
        return None
    roll = random.random() * total
    cumulative = 0.0
    for w, item in items:
        if w <= 0:
            continue
        cumulative += w
        if roll < cumulative:
            return item
    # Float-precision fallback.
    for w, item in reversed(items):
        if w > 0:
            return item
    return None

class GenyPolicy:
    def __init__(self, manifest, *, clock=time.time, locale="en", hour=12, screen_active=False, linked=None, worker_busy=False, time_context=""):
        self.manifest=manifest
        self.clock=clock
        self.locale,self.hour,self.screen_active=locale,hour,screen_active
        self.linked,self.worker_busy,self.time_context=linked,worker_busy,time_context
        self._consecutive_triggers={}
        self._last_category_fire={}
    def _resolve_manifest(self,sid): return self.manifest
    def _get_locale(self): return self.locale
    def _current_hour(self): return self.hour
    def _screen_active_for(self,sid): return self.screen_active
    def _probe_sub_worker_state(self,sid,fn): return self.linked,self.worker_busy
    def _time_context(self,locale): return self.time_context

    def _get_adaptive_threshold(self, session_id: str) -> float:
            manifest = self._resolve_manifest(session_id)
            base = manifest.timing.base_idle_seconds
            max_t = manifest.timing.max_idle_seconds
            scale_n = max(1, manifest.timing.adaptive_scale_triggers)
            count = self._consecutive_triggers.get(session_id, 0)
            if count <= 0:
                return base
            scale = math.log1p(count) / math.log1p(scale_n)
            scale = min(scale, 1.0)
            return base + (max_t - base) * scale

    def _pick_category_and_prompt(
            self, session_id: str, is_executing_fn
        ) -> Optional[Tuple[str, TriggerCategory]]:
            """Pick a category, then a prompt within it, then render.
    
            Resolution path:
    
            1. Pull the active manifest (preset or default fallback).
            2. Snapshot session state (consec, sub-worker, time window,
               screen-active).
            3. Filter the manifest's categories — keep those whose
               conditions hold under the current snapshot and whose
               per-category cooldown has elapsed.
            4. Stage-1 roulette: pick one category by ``Category.weight``.
            5. Stage-2 roulette: pick one prompt by per-prompt weight in
               the chosen category.
            6. Render via :func:`schemas.render_prompt` to the canonical
               ``[KIND_TRIGGER:id] [autonomous_signal: …] {content}`` form.
    
            Returns ``(rendered_prompt, chosen_category)``, or ``None`` when the
            manifest is disabled or no category passes the filter.
            """
            manifest = self._resolve_manifest(session_id)
            if not manifest.enabled:
                return None
    
            locale = self._get_locale()
            count = self._consecutive_triggers.get(session_id, 0)
    
            linked_id, sub_worker_busy = self._probe_sub_worker_state(
                session_id, is_executing_fn
            )
            time_window = _resolve_time_window(manifest, self._current_hour())
            screen_active = self._screen_active_for(session_id)
            now = self.clock()
            last_fires = self._last_category_fire.setdefault(session_id, {})
    
            # Build a prompt-id index once for stage-2 lookups.
            prompt_index: Dict[str, TriggerPrompt] = {
                p.id: p for p in manifest.prompts
            }
    
            eligible: List[Tuple[float, TriggerCategory]] = []
            for cat in manifest.categories:
                if not _category_eligible(
                    cat,
                    consec=count,
                    sub_worker_busy=sub_worker_busy,
                    sub_worker_linked=linked_id is not None,
                    time_window=time_window,
                    last_fire_at=last_fires.get(cat.id, 0.0),
                    now=now,
                    screen_active=screen_active,
                ):
                    continue
                if cat.weight <= 0:
                    continue
                # Skip categories that reference nothing or whose every
                # prompt_ref points at a deleted prompt.
                usable_refs = [
                    r
                    for r in cat.prompt_refs
                    if r.weight > 0 and r.prompt_id in prompt_index
                ]
                if not usable_refs:
                    continue
                eligible.append((cat.weight, cat))
    
            chosen_category = _weighted_pick(eligible)
            if chosen_category is None:
                return None
            assert isinstance(chosen_category, TriggerCategory)
    
            # Stage 2: roulette across the chosen category's prompt_refs.
            ref_pool: List[Tuple[float, PromptRef]] = [
                (r.weight, r)
                for r in chosen_category.prompt_refs
                if r.weight > 0 and r.prompt_id in prompt_index
            ]
            if not ref_pool:
                # Degenerate fallback: any non-zero ref, uniform weight.
                ref_pool = [
                    (1.0, r)
                    for r in chosen_category.prompt_refs
                    if r.prompt_id in prompt_index
                ]
            chosen_ref = _weighted_pick(ref_pool)
            if chosen_ref is None:
                return None
            assert isinstance(chosen_ref, PromptRef)
    
            prompt = prompt_index.get(chosen_ref.prompt_id)
            if prompt is None:
                return None
    
            content = (
                prompt.content.get(locale)
                or prompt.content.get("en")
                or next(iter(prompt.content.values()), "")
            )
            if not content.strip():
                return None
    
            # Mark cooldown so the next tick filters this category until the
            # window elapses.
            if chosen_category.cooldown_seconds and chosen_category.cooldown_seconds > 0:
                last_fires[chosen_category.id] = now
    
            # Explicit current-time anchor (configured tz) so idle/lonely prompts —
            # which carry no time of their own — never make the persona guess the
            # time of day (e.g. calling a 09:51 morning "evening").
            return (
                render_prompt(
                    chosen_category, content, time_context=self._time_context(locale)
                ),
                chosen_category,
            )
