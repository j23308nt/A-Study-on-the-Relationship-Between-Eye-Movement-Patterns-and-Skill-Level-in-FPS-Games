const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../validation-core.js');
const g = {width_cm:29.5,height_cm:16.7,distance_cm:30,viewport_width:1920,viewport_height:1080};
const near = (a,b) => assert(Math.abs(a-b)<1e-9, `${a} != ${b}`);
const metadata = () => ({geometry:g,seed:123,participant_id:'P01',session_number:1,run_id:'8a756db1-8596-4da3-82bc-4458f79d6e95'});
function frame(t, id, overrides={}) {
  return {frame_id:id,video_time_s:id/30,processing_start_ms:t.onset_ms+1500,processing_end_ms:t.onset_ms+1520,
    valid:true,raw_x:t.target_x,raw_y:t.target_y,x:t.target_x,y:t.target_y, ...overrides};
}
test('zero, central one-degree, symmetry and off-screen gaze',()=>{
  const c = {x:960,y:540};
  near(V.angularError(c,c,g),0);
  const one = {x:960+30*Math.tan(Math.PI/180)*1920/29.5,y:540};
  near(V.angularError(c,one,g),1);
  near(V.angularError(one,c,g),1);
  assert(V.angularError(c,{x:3000,y:540},g)>30);
  assert.equal(V.angularError(c,{x:null,y:540},g),null);
  assert.throws(()=>V.angularError(c,c,{...g,distance_cm:0}));
});
test('CSS scaling leaves visual angle unchanged; peripheral angle is not central conversion',()=>{
  const a={x:1700,y:900},b={x:1800,y:910};
  near(V.angularError(a,b,g),V.angularError({x:850,y:450},{x:900,y:455},{...g,viewport_width:960,viewport_height:540}));
  assert(Math.abs(V.angularError(a,b,g)-V.angularError({x:960,y:540},{x:1060,y:550},g))>0.1);
});
test('reproducible order, nine locations per block, no boundary repeats',()=>{
  for(let seed=0;seed<100;seed++) {
    const order=V.createOrder(seed);
    assert.deepEqual(order,V.createOrder(seed));
    assert.equal(order.length,27);
    for(let b=0;b<3;b++) assert.equal(new Set(order.slice(b*9,b*9+9).map(t=>t.point_id)).size,9);
    assert.notEqual(order[8].point_id,order[9].point_id);
    assert.notEqual(order[17].point_id,order[18].point_id);
  }
});
test('warmup, transition, duplicate and failed frames are preserved but not valid accuracy samples',()=>{
  const s=new V.Session(metadata()); const t=s.startTrial(0);
  s.recordFrame(frame(t,1,{processing_start_ms:500,processing_end_ms:520}));
  s.recordFrame(frame(t,2,{valid:false,failure_reason:'no_face',raw_x:null,raw_y:null,x:null,y:null}));
  s.recordFrame(frame(t,3));
  assert.equal(s.recordFrame(frame(t,3)),false);
  s.recordFrame(frame(t,4,{processing_start_ms:2900,processing_end_ms:3100}));
  s.endTrial(3010); s.finish(3010,'test_stop');
  const out=s.export(); const trial=out.summary.trials[0];
  assert.equal(out.frames.length,4);
  assert.equal(trial.valid_samples,1);
  assert.equal(trial.processed_frames,3);
  near(trial.invalid_fraction,1/3);
  assert.equal(trial.boundary_frames,1);
  assert.equal(out.frames[1].error_deg,null);
  assert.equal(out.frames[0].included_in_analysis,false);
  assert.equal(out.summary.mean_error_deg,null);
});
test('abort invalidates the partial trial and retains its frames',()=>{
  const s=new V.Session(metadata()); const t=s.startTrial(0);
  s.recordFrame(frame(t,1));s.finish(2000,'viewport_changed');
  const out=s.export();
  assert.equal(out.frames.length,1);
  assert.equal(out.frames[0].included_in_analysis,false);
  assert.equal(out.summary.trials[0].mean_error_deg,null);
  assert.equal(out.summary.status,'aborted');
});
test('camera silence yields unknown error, unknown failure fraction, zero throughput and full gap',()=>{
  const s=new V.Session(metadata()); s.startTrial(0);s.endTrial(3000);s.finish(3000,'test_stop');
  const t=s.summarize().trials[0];
  assert.equal(t.mean_error_deg,null);assert.equal(t.invalid_fraction,null);
  assert.equal(t.valid_samples_per_second,0);assert.equal(t.max_valid_gap_ms,2000);
});
test('equal trial/position weighting, pooled p95, complete-session mean',()=>{
  const s=new V.Session(metadata());let id=0, centerVisit=0;
  for(let i=0;i<27;i++) {
    const t=s.startTrial(i*3000);
    let x=t.target_x, count=1;
    if(t.point_id==='V5') { const degrees=[1,3,5][centerVisit++]; x+=30*Math.tan(degrees*Math.PI/180)*1920/29.5; if(degrees===1)count=5; }
    for(let k=0;k<count;k++) s.recordFrame(frame(t,++id,{x,processing_start_ms:t.onset_ms+1100+k*100,processing_end_ms:t.onset_ms+1120+k*100}));
    s.endTrial((i+1)*3000);
  }
  s.finish(81000); const out=s.export();const p=out.summary.positions.find(p=>p.point_id==='V5');
  assert.equal(out.summary.data_complete,true);near(p.mean_error_deg,3);near(p.p95_error_deg,4.4);
  near(out.summary.mean_error_deg,1/3);near(out.summary.raw_mean_error_deg,0);
  const files=V.exportFiles(out);
  assert.equal(Object.keys(files).length,4);
  assert(files['samples.csv'].includes('raw_error_deg'));
  assert.equal(JSON.parse(files['session.json']).metadata.participant_id,'P01');
});
test('JSON and CSV preserve optional correction mode including unknown legacy metadata',()=>{
  for(const mode of [false,true,undefined]) {
    const s=new V.Session({...metadata(),tracker:{five_point_correction_applied:mode}});
    const t=s.startTrial(0); s.recordFrame(frame(t,1)); s.endTrial(3000); s.finish(3000,'test_stop');
    const files=V.exportFiles(s.export());
    assert.equal(JSON.parse(files['session.json']).metadata.tracker.five_point_correction_applied,mode);
    for(const name of ['samples.csv','trials.csv','positions.csv']) {
      const [header,row]=files[name].split('\r\n');
      const column=header.split(',').indexOf('five_point_correction_applied');
      assert(column>=0);
      assert.equal(row.split(',')[column],mode===undefined?'':String(mode));
    }
  }
});

test('CSV keeps missing values empty and escapes text',()=>{
  assert.equal(V.csv([{a:null,b:'a,"b',c:'=1+1'}],['a','b','c']), 'a,b,c\r\n,"a,""b",\'=1+1');
});

test('JSON and all CSVs preserve head condition and angle reference; legacy remains unknown',()=>{
  for(const condition of ['fixed','free',undefined]) {
    const reference='initial_centered_eye_position_and_declared_distance';
    const s=new V.Session({...metadata(),head_condition:condition,angular_error_reference:reference});
    const t=s.startTrial(0); s.recordFrame(frame(t,1)); s.endTrial(3000); s.finish(3000,'test_stop');
    const files=V.exportFiles(s.export());
    assert.equal(JSON.parse(files['session.json']).metadata.head_condition,condition);
    for(const name of ['samples.csv','trials.csv','positions.csv']) {
      const [header,row]=files[name].split('\r\n').map(line=>line.split(','));
      assert.equal(row[header.indexOf('head_condition')],condition??'');
      assert.equal(row[header.indexOf('angular_error_reference')],reference);
    }
  }
});
