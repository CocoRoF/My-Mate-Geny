import { test } from "node:test";
import assert from "node:assert/strict";
import { sidePanelPreferences, panelWidth } from "../src/lib/sidePanel.ts";
import { useTaskStore, visibleTasks } from "../src/stores/taskStore.ts";
import type { TaskInfo } from "../src/types/index.ts";

const task = (id: string, status = "completed", at = 1): TaskInfo => ({ task_id: id, status, started_at: at });
test("only selected task pages and running work are visible, with deterministic ordering", () => {
  assert.deepEqual(visibleTasks([task('a'),task('b'),task('old','running',0),task('c','completed',2)],['b','c']).map(t=>t.task_id),['c','b','old']);
});
test("one side panel and shared width migrate existing explorer choices without losing custom sizes", () => {
  assert.deepEqual(sidePanelPreferences({explorerOpen:true,explorerWidth:460},'session'), {sidePanel:'explorer',explorerOpen:true,panelWidth:460});
  assert.equal(sidePanelPreferences({sidePanel:'session',panelWidth:380},null).panelWidth,380);
  assert.equal(sidePanelPreferences({sidePanel:null},'session').sidePanel,null);
  assert.equal(sidePanelPreferences({},'session').panelWidth,340);
  assert.equal(panelWidth(NaN),340);assert.equal(panelWidth(900),640);assert.equal(panelWidth(0),220);
});
test("task metadata is fetched in pages, stale requests cannot replace a newer reset, failures can retry", async () => {
  const original=globalThis.fetch;
  const pending: {url:string,resolve:(r:Response)=>void}[]=[];
  globalThis.fetch=((url:any)=>new Promise<Response>(resolve=>pending.push({url:String(url),resolve}))) as typeof fetch;
  const response=(ids:string[],cursor:string|null)=>new Response(JSON.stringify({tasks:ids.map(id=>task(id)),running:[task('running','running',0)],page:{cursor,has_more:!!cursor,start:'2026-11-01T00:00:00Z',until:null,turns:2}}),{status:200});
  try {
    const s=useTaskStore.getState();
    const first=s.loadSession('paging-unit');
    useTaskStore.setState(s=>({paging:{...s.paging,'paging-unit':{...s.paging['paging-unit'],expanded:true}}}));
    const reset=s.loadSession('paging-unit',true);
    pending[1].resolve(response(['new'],'next'));await reset;
    pending[0].resolve(response(['stale'],null));await first;
    assert.deepEqual(useTaskStore.getState().paging['paging-unit'].ids,['new']);
    const more=s.loadMore('paging-unit');assert(pending[2].url.includes('cursor=next'));
    pending[2].resolve(response(['old'],null));await more;
    assert.deepEqual(useTaskStore.getState().paging['paging-unit'].ids,['new','old']);
    const failed=s.loadSession('paging-unit',true);pending[3].resolve(new Response('failed',{status:500}));await failed;
    assert(useTaskStore.getState().paging['paging-unit'].error);
    s.upsert('paging-unit',task('missed-finish','running',0));
    const retry=s.loadSession('paging-unit');pending[4].resolve(response(['retry'],null));await retry;
    assert.equal(useTaskStore.getState().paging['paging-unit'].error,null);
    assert(!useTaskStore.getState().bySession['paging-unit'].some(t=>t.task_id==='missed-finish')); 
  } finally {globalThis.fetch=original;}
});

import { fmtMs } from "../src/components/chat/turn/toolMeta.ts";
test("elapsed time carries rounded seconds into minutes instead of showing 1m 60s", () => {
  assert.equal(fmtMs(119999), fmtMs(120000));
  assert.equal(fmtMs(59999), fmtMs(60000));
  assert.equal(fmtMs(3599999), fmtMs(3600000));
});
