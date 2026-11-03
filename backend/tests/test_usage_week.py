import json
from datetime import datetime,timezone
import pytest
from app.services.usage_week import week
from tests.test_mate_screen import _services
from app.providers.base import ProviderEvent
NOW=datetime(2026,11,3,14,tzinfo=timezone.utc)
def event(svc,sid,when,**data):
    ev=ProviderEvent(type='turn.complete',data=data);ev.timestamp=when;svc._add_event(sid,ev)

def test_seven_days_source_models_tokens_cost_and_legacy_boundary(db,tmp_path):
 svc,atts,store,mates,_=_services(db)
 m=store.create(name='Mate');mid=mates.conversation(m['id'])['session_id']
 sid=svc.create(provider='claude',workspace_path=str(tmp_path),title='Coding')['id']
 # Cumulative legacy costs before the window must be subtracted, never counted in this week.
 event(svc,sid,'2026-10-01T00:00:00+00:00',provider='claude',cost_usd=10)
 event(svc,sid,'2026-11-01T00:00:00+00:00',provider='claude',cost_usd=11,model='claude-test',usage={'input_tokens':100,'output_tokens':20})
 event(svc,mid,'2026-11-02T00:00:00+00:00',provider='codex',model='gpt-test',cost_kind='none',usage={'input_tokens':30,'cache_read_input_tokens':50,'cache_creation_input_tokens':10})
 # Outside the selected local calendar window, excluded from all totals, rankings and daily series.
 event(svc,sid,'2026-11-04T00:00:00+00:00',cost_kind='turn',cost_usd=999)
 r=week(db,'UTC',now=NOW);assert len(r['daily'])==7
 assert r['total']['tokens']==210 and r['total']['cost_usd']==1
 assert r['total']['unknown_cost_turns']==1
 a,b,c=r['sources'];assert a['tokens']==120 and b['tokens']==90 and c['turns']==0
 assert sum(x['tokens'] for x in r['sources'])==r['total']['tokens']
 assert sum(d[k]['tokens'] for d in r['daily'] for k in ('chat','mate','internal'))==210
 assert b['items'][0]['title']=='Mate' and b['items'][0]['mate_id']==m['id']
 assert a['items'][0]['models']==[{'provider':'claude','model':'claude-test'}]
 assert 'text' not in json.dumps(r) and r['historical_source_inferred_turns']==2

def test_local_calendar_zero_fill_unknown_cost_and_invalid_json(db,tmp_path):
 svc,atts,store,mates,_=_services(db);sid=svc.create(provider='codex',workspace_path=str(tmp_path))['id']
 event(svc,sid,'2026-10-27T15:01:00+00:00',provider='codex',cost_kind='none',usage={'output_tokens':3}) # Oct 28 KST included
 event(svc,sid,'2026-10-27T14:59:00+00:00',provider='codex',cost_kind='none',usage={'output_tokens':900})
 db.execute("INSERT INTO events(session_id,seq,type,data,created_at) VALUES (?,0,'turn.complete','broken','2026-11-01')",(sid,))
 r=week(db,'Asia/Seoul',now=NOW);assert r['total']['tokens']==3 and r['total']['unknown_cost_turns']==1
 assert r['daily'][0]['day']=='2026-10-28' and r['daily'][0]['chat']['tokens']==3

def test_top_five_recorded_source_and_unbilled_errors(db,tmp_path):
 svc,atts,store,mates,_=_services(db)
 for n in range(7):
  sid=svc.create(provider='claude',workspace_path=str(tmp_path),title=str(n))['id']
  event(svc,sid,'2026-11-01T00:00:00+00:00',usage_source='internal',cost_kind='turn',cost_usd=n,usage={'output_tokens':n})
  svc._add_event(sid,ProviderEvent(type='error',data={'message':'private text must not be selected'}))
 r=week(db,now=NOW);assert r['total']['turns']==7
 internal=r['sources'][2];assert [i['title'] for i in internal['items']]==['6','5','4','3','2']
 assert r['sources'][0]['turns']==0 and internal['share']==1
