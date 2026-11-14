"""Product-owned event rules. User presets are archived data, not live scheduling inputs."""
from .policy import GenyPolicy, _category_eligible, _resolve_time_window

# What each moment is, and only that: whether she speaks up, and about what, is hers (runtime.SPEAK_UP). The screen is
# only there so she knows what they are up to; it is never the topic.
FIXED_CONTENT={
    'screen_observation':'It has gone quiet; they are at their computer (the picture shows what they have in front of them).',
    'sub_worker_working':'It has gone quiet; a chat you passed work on to is still on it.',
    'first_idle':'It has gone quiet for a bit.',
    'continued_idle':'Still quiet: they haven\'t answered what you said last.',
    'long_idle':'It has been quiet for a long while.',
    'time':'A new part of the day has begun.',
}

def moment(key):
    """The message of a moment with no message from them: what the moment is, nothing about what to say (the time is in her
    <context>)."""
    return FIXED_CONTENT.get(key) or FIXED_CONTENT['time']

class FixedPolicy(GenyPolicy):
    def _pick_category_and_prompt(self,sid,is_executing_fn):
        manifest=self._resolve_manifest(sid)
        if not manifest.enabled:return None
        now=self.clock();count=self._consecutive_triggers.get(sid,0)
        linked,busy=self._probe_sub_worker_state(sid,is_executing_fn)
        window=_resolve_time_window(manifest,self._current_hour())
        fires=self._last_category_fire.setdefault(sid,{})
        categories={c.id:c for c in manifest.categories}
        # Deterministic priority. Unchanged screens are skipped by the frame owner before model work.
        order=['screen_observation','sub_worker_working',f'time_{window}','first_idle','continued_idle','long_idle']
        for key in order:
            cat=categories.get(key)
            if not cat or not _category_eligible(cat,consec=count,sub_worker_busy=busy,sub_worker_linked=linked is not None,
                    time_window=window,last_fire_at=fires.get(key,0),now=now,screen_active=self._screen_active_for(sid)):continue
            # Time greetings once per part of day; linked work at most once per five minutes.
            cooldown=21600 if key.startswith('time_') else 300 if key=='sub_worker_working' else cat.cooldown_seconds
            if now-fires.get(key,-1e12)<cooldown:continue
            fires[key]=now
            return moment(key), cat
        return None
