const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../aim-core.js');
const {csv} = require('../validation-core.js');
const config = () => ({run_id:'8a756db1-8596-4da3-82bc-4458f79d6e95',participant_id:'P01',session_number:1,
  head_condition:'free',tracker:{five_point_correction_applied:false},seed:42,start_ms:100,
  trial_count:3,target_diameter_px:48,timeout_ms:3000,viewport_width:1920,viewport_height:1080});

test('seeded target sequence stays on screen and preserves fixed parameters',()=>{
  const c=config(), order=A.createOrder(c);
  assert.deepEqual(order,A.createOrder(c)); assert.notDeepEqual(order,A.createOrder({...c,seed:43}));
  for(const t of order) {
    assert(t.target_x-t.target_radius_px>0 && t.target_x+t.target_radius_px<c.viewport_width);
    assert(t.target_y-t.target_radius_px>0 && t.target_y+t.target_radius_px<c.viewport_height);
    assert(t.gap_after_ms>=500 && t.gap_after_ms<=1000);
  }
  for(const bad of [{trial_count:0},{target_diameter_px:500},{timeout_ms:0},{seed:NaN},{viewport_width:200}])
    assert.throws(()=>new A.Session({...c,...bad}));
});

test('targets can reach all four former 12-percent edge bands with a 20px outer margin',()=>{
  const c={...config(),trial_count:100}, order=A.createOrder(c);
  assert(order.some(t=>t.target_x<c.viewport_width*0.12));
  assert(order.some(t=>t.target_x>c.viewport_width*0.88));
  assert(order.some(t=>t.target_y<c.viewport_height*0.12));
  assert(order.some(t=>t.target_y>c.viewport_height*0.88));
  for(const viewport of [[1920,1080],[320,320]]) {
    for(const diameter of [16,48,160]) {
      const settings={...c,viewport_width:viewport[0],viewport_height:viewport[1],target_diameter_px:diameter};
      for(const t of A.createOrder(settings)) {
        assert(t.target_x-t.target_radius_px>=20);
        assert(t.target_y-t.target_radius_px>=20);
        assert(t.target_x+t.target_radius_px<=settings.viewport_width-20);
        assert(t.target_y+t.target_radius_px<=settings.viewport_height-20);
      }
    }
  }
});

test('miss then hit records first-click and successful response separately, no double hit',()=>{
  const s=new A.Session(config()), t=s.present(1000);
  assert.equal(s.click(1200,0,0).outcome,'miss');
  assert.equal(s.click(1500,t.target_x,t.target_y).outcome,'hit');
  assert.equal(s.click(1501,t.target_x,t.target_y).outcome,'between_targets');
  assert.equal(t.first_click_ms,200); assert.equal(t.hit_response_ms,500); assert.equal(t.miss_clicks,1);
  s.finish(1600,'user_escape'); const out=s.export();
  assert.equal(out.summary.hits,1); assert.equal(out.summary.mean_hit_response_ms,500);
  assert.equal(out.summary.click_hit_fraction,0.5); assert.equal(out.summary.outside_window_clicks,1);
});

test('timeout boundary cannot be scored as a hit; no-hit summary uses null, not zero',()=>{
  const s=new A.Session({...config(),trial_count:1}), t=s.present(1000);
  assert.equal(s.click(4000,t.target_x,t.target_y).outcome,'late');
  s.finish(4010); const out=s.export();
  assert.equal(out.summary.status,'completed'); assert.equal(out.summary.timeouts,1);
  assert.equal(out.summary.mean_hit_response_ms,null); assert.equal(out.summary.click_hit_fraction,null);
  assert.equal(t.first_click_ms,null); assert.equal(t.hit_response_ms,null);
});

test('gaze frames associate by processing start; retain gaps, failures, raw output and late completion',()=>{
  const s=new A.Session(config()), t=s.present(1000);
  const f={frame_id:1,processing_start_ms:1100,processing_end_ms:1130,x:10,y:20,raw_x:-10,raw_y:20,valid:true};
  assert.equal(s.recordFrame(f),true); assert.equal(s.recordFrame(f),false);
  s.recordFrame({...f,frame_id:2,processing_start_ms:900,processing_end_ms:930});
  s.recordFrame({...f,frame_id:3,processing_start_ms:1200,processing_end_ms:1230,valid:false,failure_reason:'no_face'});
  s.click(1300,t.target_x,t.target_y);
  s.recordFrame({...f,frame_id:4,processing_start_ms:1290,processing_end_ms:1320});
  s.finish(1400,'user_escape');
  assert.equal(s.recordFrame({...f,frame_id:5,processing_start_ms:1450}),false);
  const out=s.export(); assert.equal(out.gaze.length,4);
  assert.equal(out.gaze[0].trial_id,1); assert.equal(out.gaze[0].raw_x,-10);
  assert.equal(out.gaze[1].trial_id,null); assert.equal(out.gaze[2].failure_reason,'no_face');
  assert.equal(out.gaze[3].crosses_target_end,true); assert.equal(out.trials[0].valid_gaze_samples,1);
});

test('aborts retain partial trial and clicks; all four files have headers even before first target',()=>{
  const s=new A.Session(config()); s.click(200,10,10); s.finish(300,'user_escape');
  const out=s.export(), files=A.exportFiles(out,csv);
  assert.equal(out.summary.status,'aborted'); assert.equal(out.summary.presented_trials,0);
  assert.equal(Object.keys(files).length,4);
  assert(files['gaze.csv'].includes('raw_x')); assert(files['trials.csv'].includes('hit_response_ms'));
  assert(files['clicks.csv'].includes('between_targets'));
  assert.equal(JSON.parse(files['session.json']).metadata.head_condition,'free');
  const partial=new A.Session(config()); partial.present(1000); partial.click(1200,0,0); partial.finish(1500,'window_blur');
  assert.equal(partial.export().trials[0].status,'aborted');
  assert.equal(partial.export().trials[0].first_click_ms,200);
});

test('completed run mean and median use hits only and preserve timeouts',()=>{
  const s=new A.Session(config());
  let t=s.present(1000); s.click(1200,t.target_x,t.target_y);
  t=s.present(2000); s.click(2600,t.target_x,t.target_y);
  s.present(4000); assert.equal(s.expire(6999),false); assert.equal(s.expire(7000),true); s.finish(7000);
  const out=s.export(); assert.equal(out.summary.status,'completed');
  assert.equal(out.summary.mean_hit_response_ms,400); assert.equal(out.summary.median_hit_response_ms,400);
  assert.equal(out.summary.timeouts,1); assert.equal(out.summary.hits,2);
});

test('cursor movement is rate limited, clicks are forced, and all phases and aborts are retained',()=>{
  const s=new A.Session({...config(),cursor_recording:{minimum_move_interval_ms:A.CURSOR_INTERVAL_MS}});
  const p=(time,x=10,kind='move')=>({time_ms:time,event_timestamp_ms:time-1,x,y:20,buttons:kind==='button_down'?1:0,sample_kind:kind});
  assert.equal(s.recordCursor(p(50)),false); // before task
  assert.equal(s.recordCursor(p(200)),true); // countdown
  assert.equal(s.recordCursor(p(201)),false); // throttled movement
  const t=s.present(1000);
  assert.equal(s.recordCursor(p(1100)),true);
  assert.equal(s.recordCursor(p(1120,30)),true);
  assert.equal(s.recordCursor(p(1121,t.target_x,'button_down')),true); // never throttle a button press
  s.click(1121,t.target_x,t.target_y);
  assert.equal(s.recordCursor(p(1200)),true); // gap
  s.finish(1300,'user_escape');assert.equal(s.recordCursor(p(1400)),false);
  const out=s.export();assert.equal(out.cursor.length,5);assert.equal(out.cursor[0].trial_id,null);
  assert.equal(out.cursor[3].trial_id,1);assert.equal(out.cursor[3].time_from_target_ms,121);
  assert.equal(out.cursor[4].trial_id,null);assert.equal(out.summary.cursor_samples,5);
  assert.doesNotThrow(()=>A.checkCursor(out.cursor,out.metadata,out.trials));
  const files=A.exportFiles(out,csv);assert.equal(Object.keys(files).length,5);
  assert(files['cursor.csv'].includes('event_timestamp_ms'));assert(files['cursor.csv'].includes('button_down'));
  assert.equal(JSON.parse(files['session.json']).cursor.length,5);
  const bad=structuredClone(out.cursor);bad[1].time_ms=100;assert.throws(()=>A.checkCursor(bad,out.metadata,out.trials));
});

test('new empty cursor recordings have a CSV header; legacy bundles remain four files',()=>{
  const s=new A.Session({...config(),cursor_recording:{version:1}});s.finish(200,'user_escape');
  assert.equal(A.exportFiles(s.export(),csv)['cursor.csv'].split('\r\n').length,1);
  const legacy=new A.Session(config());legacy.finish(200,'user_escape');
  assert.equal(legacy.export().cursor,undefined);assert.equal(Object.keys(A.exportFiles(legacy.export(),csv)).length,4);
});
