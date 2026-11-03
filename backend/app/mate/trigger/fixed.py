"""Product-owned event rules. User presets are archived data, not live scheduling inputs."""
from .policy import GenyPolicy, _category_eligible, _resolve_time_window
from .schemas import render_prompt

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
            content={
                'screen_observation':'현재 공유 화면과 최근 대화를 확인하고, 새롭게 도움이 될 내용이 있을 때만 짧게 말을 건다.',
                'sub_worker_working':'연결된 작업이 진행 중이다. 확인된 진행 상황이 도움이 될 때만 짧게 전한다.',
                'first_idle':'최근 대화가 잠시 멈췄다. 맥락에 맞게 자연스럽게 말을 건넬 필요가 있는지 판단한다.',
                'continued_idle':'사용자의 답이 없는 상태다. 반복하거나 재촉하지 말고 필요할 때만 말을 건다.',
                'long_idle':'오랫동안 답이 없다. 방해하지 않는 것을 우선하고 특별한 이유가 없으면 조용히 있는다.',
            }.get(key,'현재 시간대와 최근 대화에 맞는 짧은 안부가 필요한지 판단한다.')
            return render_prompt(cat,content,time_context=self._time_context(self._get_locale())), cat
        return None
