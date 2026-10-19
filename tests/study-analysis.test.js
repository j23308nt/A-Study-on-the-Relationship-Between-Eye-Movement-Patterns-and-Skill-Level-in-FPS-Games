const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../study-analysis-core.js'),F=require('./study-fixtures.cjs');
test('validation recalculates errors, preserves incomplete and zero values',()=>{
  const data=F.validation({offset:0}); data.summary.mean_error_deg=999;
  const r=S.normalize(data); assert.equal(r.kind,'validation'); assert.equal(r.complete,true); assert.equal(r.primary,0);
  assert.equal(r.valid_samples,81); assert.equal(r.invalid_fraction,0);
  const missing=S.normalize(F.validation({missing:true})); assert.equal(missing.complete,false); assert.equal(missing.primary,null);
  assert.equal(missing.data.summary.positions.filter(p=>p.trials_with_data===2).length,1);
  const partial=S.normalize(F.validation({partial:true})); assert.equal(partial.complete,false); assert.equal(partial.primary,null);
});
test('aim recomputes response times from clicks, keeps timeouts and absent means',()=>{
  const data=F.aim(); data.trials[0].hit_response_ms=999; data.summary.mean_hit_response_ms=999;
  const r=S.normalize(data); assert.equal(r.primary,200); assert.equal(r.data.summary.hits,2);
  assert.equal(r.data.summary.timeouts,1); assert.equal(r.data.summary.miss_clicks,1);
  assert.equal(r.data.trials[0].first_click_ms,100); assert.equal(r.complete,true);
  const noHits=S.normalize(F.aim({noHits:true})); assert.equal(noHits.complete,true); assert.equal(noHits.primary,null);
});
test('same conditions aggregate equal sessions, not frames; aborted excluded',()=>{
  const a=S.normalize(F.validation({offset:10})),b=S.normalize(F.validation({id:'second',session:2,offset:30}));
  const p=S.normalize(F.validation({id:'partial',session:3,partial:true}));
  const groups=S.groups([a,b,p]); assert.equal(groups.length,1); assert.equal(groups[0].eligible,2);
  assert.equal(groups[0].primary.mean,(a.primary+b.primary)/2); assert.equal(groups[0].primary.n,2);
  assert(Math.abs(groups[0].primary.sd-Math.abs(a.primary-b.primary)/Math.sqrt(2))<1e-12);
});
test('head, correction, task, seed, camera, environment and code differences are separated',()=>{
  const base=F.aim();
  for(const mutate of [d=>d.metadata.head_condition='free',d=>d.metadata.tracker.five_point_correction_applied=true,
    d=>d.metadata.seed=43,d=>d.metadata.target_diameter_px=50,d=>d.metadata.tracker.camera_label='different',
    d=>d.metadata.environment_notes='different',d=>d.metadata.source_sha256={'app.js':'changed'}]) {
    const other=structuredClone(base);other.metadata.run_id='other'; other.metadata.session_number=2; mutate(other);
    assert.equal(S.groups([S.normalize(base),S.normalize(other)]).length,2);
  }
  assert.equal(S.groups([S.normalize(base),S.normalize(F.validation())]).length,2);
});
test('duplicate session number disables aggregation; legacy unknown is not assumed fixed',()=>{
  const a=S.normalize(F.validation()), b=S.normalize(F.validation({id:'other'}));
  const g=S.groups([a,b])[0]; assert.equal(g.duplicate,true);assert.equal(g.primary.mean,null);
  const legacy=F.validation(); delete legacy.metadata.head_condition;
  const r=S.normalize(legacy);assert.equal(r.head,'unknown');assert.equal(r.conditionKnown,false);
  assert.equal(S.groups([r])[0].primary.n,0);
});
test('statistics filter missing values but preserve zero, sample SD and empty distributions',()=>{
  assert.deepEqual(S.stats([null,undefined,NaN]),{n:0,mean:null,median:null,p95:null,min:null,max:null,sd:null});
  const s=S.stats([0,2,4]);assert.equal(s.mean,2);assert.equal(s.sd,2);assert.equal(s.p95,3.8);
  assert.equal(S.stats([0]).sd,null);assert.deepEqual(S.histogram([]),[]);
  assert.equal(S.histogram([4,4,4])[0].count,3);
  assert.equal(S.histogram(Array.from({length:150000},(_,i)=>i%100)).reduce((s,b)=>s+b.count,0),150000);
});
test('malformed JSON structures, duplicate frames, bad timing and impossible hit are rejected',()=>{
  assert.throws(()=>S.normalize({schema:'wrong'}));
  const bad=F.validation();bad.frames[0].raw_x=null;assert.throws(()=>S.normalize(bad));
  const duplicate=F.validation();duplicate.frames[1].frame_id=duplicate.frames[0].frame_id;assert.throws(()=>S.normalize(duplicate));
  const timing=F.validation();timing.summary.trials[0].analysis_end_ms=1;assert.throws(()=>S.normalize(timing));
  const click=F.aim();click.clicks[0].x=0;click.clicks[0].y=0;assert.throws(()=>S.normalize(click));
});
test('export columns keep the two primary metrics in separate units and include conditions',()=>{
  const rows=S.exportRows([S.normalize(F.validation()),S.normalize(F.aim())]);
  assert.equal(rows[0].mean_hit_response_ms,null); assert.equal(rows[1].mean_error_deg,null);
  assert.equal(rows[1].mean_hit_response_ms,200); assert(rows[1].condition_signature.includes('timeout_ms'));
  assert.equal(S.stable({b:1,a:2}),S.stable({a:2,b:1}));
});

test('analysis preserves new cursor samples and still reads legacy aim records',()=>{
  const data=F.aim();data.metadata.cursor_recording={version:1};
  data.cursor=[{sample_id:1,time_ms:1050,event_timestamp_ms:1049,x:10,y:20,trial_id:1,sample_kind:'move',buttons:0}];
  const r=S.normalize(data);assert.deepEqual(r.data.cursor,data.cursor);
  assert.equal(r.data.summary.cursor_samples,1);assert.equal(S.normalize(F.aim()).data.cursor,undefined);
  data.cursor[0].x=null;assert.throws(()=>S.normalize(data));
});
