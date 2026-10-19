const V=require('../validation-core.js'), A=require('../aim-core.js');
function metadata(id,session=1,head='fixed') {
  return {run_id:id,participant_id:'P01',session_number:session,head_condition:head,vision:'unaided',seed:42,start_ms:0,
    device_pixel_ratio:1,source_sha256:{'app.js':'synthetic-test-only'},environment_notes:'synthetic test',
    tracker:{five_point_correction_applied:false,camera_label:'synthetic',camera_settings:{width:1280,height:720},smoothing:{test:true}}};
}
function validation({id='validation-1',session=1,head='fixed',offset=10,partial=false,missing=false}={}) {
  const s=new V.Session({...metadata(id,session,head),geometry:{width_cm:29.5,height_cm:16.7,distance_cm:30,viewport_width:1920,viewport_height:1080}});
  let frame=0;
  for(let i=0;i<27;i++) {
    const t=s.startTrial(i*3000);
    for(let j=0;j<3;j++) {
      s.recordFrame({frame_id:++frame,video_time_s:frame/30,processing_start_ms:t.onset_ms+1100+j*100,processing_end_ms:t.onset_ms+1110+j*100,
        x:t.target_x+offset,y:t.target_y,raw_x:t.target_x+offset+2,raw_y:t.target_y,valid:!(missing && i===0),failure_reason:missing&&i===0?'no_face':''});
    }
    if(partial){s.finish(t.onset_ms+2000,'user_escape');return s.export();}
    s.endTrial((i+1)*3000);
  }
  s.finish(81000);return s.export();
}
function aim({id='aim-1',session=1,head='fixed',partial=false,noHits=false}={}) {
  const s=new A.Session({...metadata(id,session,head),trial_count:3,target_diameter_px:48,timeout_ms:3000,viewport_width:1920,viewport_height:1080,
    width_cm:29.5,height_cm:16.7,distance_cm:30,inter_target_gap_ms:[500,1000],response_clock:'synthetic'});
  for(let i=0;i<3;i++) {
    const t=s.present(i*4000+1000);
    s.recordFrame({frame_id:i+1,processing_start_ms:t.onset_ms+50,processing_end_ms:t.onset_ms+60,
      x:100,y:200,raw_x:98,raw_y:203,valid:true});
    if(partial){s.finish(t.onset_ms+75,'user_escape');return s.export();}
    if(noHits||i===2)s.expire(t.deadline_ms);
    else {
      if(i===1)s.click(t.onset_ms+100,0,0);
      s.click(t.onset_ms+(i===0?100:300),t.target_x,t.target_y);
    }
  }
  s.finish(12000);return s.export();
}
module.exports={validation,aim};
