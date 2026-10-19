// Browser smoke test with synthetic landmarks/video only; no camera access or research-data writes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({headless:true, channel:process.platform==='win32'?'msedge':undefined});
  const page = await browser.newPage({viewport:{width:1440,height:1000},screen:{width:1920,height:1080},acceptDownloads:true});
  const errors = [];
  page.on('pageerror', error=>errors.push(error.message));
  const bundles=[];
  let failSave=false;
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'gaze-validation-ui-'));
  try {
    await page.route('**/save-validation', async route=>{
      const payload=route.request().postDataJSON();
      bundles.push(JSON.parse(payload.files['session.json']));
      await route.fulfill({status:failSave?500:200,contentType:'application/json',body:JSON.stringify(failSave?
        {ok:false,error:'Simulated storage failure'}:{ok:true,path:`recordings/validation/${payload.run_id}`})});
    });
    await page.route('**/mediapipe/face_mesh/face_mesh.js', route=>route.fulfill({contentType:'text/javascript',body:`
      window.FaceMesh = class {
        setOptions(){} async initialize(){} onResults(fn){this.callback=fn;}
        async send(){
          window.__fakeFrames=(window.__fakeFrames||0)+1;
          if(window.__fakeFrames%13===0){this.callback({multiFaceLandmarks:[]});return;}
          const correction=document.querySelector('.auto-correction-target');
          let gaze=window.__gaze||{x:0.5,y:0.5};
          if(correction)gaze={x:parseFloat(correction.style.left)/100,y:parseFloat(correction.style.top)/100};
          const l=Array.from({length:478},()=>({x:0.5,y:0.5,z:0}));
          const p=(i,x,y)=>{l[i]={x,y,z:0};};
          p(10,0.5,0.2);p(152,0.5,0.8);p(1,0.5,0.5);
          p(33,0.25,0.4);p(133,0.45,0.4);p(159,0.35,0.36);p(145,0.35,0.44);
          p(362,0.55,0.4);p(263,0.75,0.4);p(386,0.65,0.36);p(374,0.65,0.44);
          for(let i=468;i<=472;i++)p(i,0.35+(gaze.x-0.5)*0.16,0.4+(gaze.y-0.5)*0.06);
          for(let i=473;i<=477;i++)p(i,0.65+(gaze.x-0.5)*0.16,0.4+(gaze.y-0.5)*0.06);
          this.callback({multiFaceLandmarks:[l]});
        }
      };
    `}));
    await page.addInitScript(()=>{
      navigator.mediaDevices.getUserMedia=async()=>new MediaStream();
      for(const [name,get] of Object.entries({readyState:()=>4,videoWidth:()=>1280,videoHeight:()=>720,currentTime:()=>Math.floor(performance.now()/33)/30})) {
        Object.defineProperty(HTMLVideoElement.prototype,name,{get,configurable:true});
      }
      HTMLVideoElement.prototype.play=async()=>{};
      HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){
        return requestAnimationFrame(now=>callback(now,{mediaTime:Math.floor(performance.now()/33)/30,
          presentedFrames:Math.floor(performance.now()/33),expectedDisplayTime:now}));
      };
      HTMLVideoElement.prototype.cancelVideoFrameCallback=id=>cancelAnimationFrame(id);
    });
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now()+1000));
    await page.goto(process.env.VALIDATION_URL || 'http://localhost:8000/');
    await page.locator('#validationSetupBtn').click();
    await page.screenshot({path:path.join(artifacts,'setup-desktop.png')});
    await page.locator('#vPositionConfirmed').check();
    await page.locator('#validationPrepareBtn').click();
    assert((await page.locator('#validationSetupError').innerText()).includes('カメラ'));
    await page.locator('#validationSetupClose').click();
    await page.locator('#startBtn').click();
    await page.clock.runFor(500);
    // Starting without validation-specific setup opens a recoverable preparation flow.
    await page.locator('#validationRunBtn').click();
    assert.equal(await page.locator('#validationSetup').evaluate(e=>e.open),true);
    await page.locator('#validationSetupClose').click();

    async function calibrate(withCorrection=false, headCondition='fixed') {
      await page.locator('#validationSetupBtn').click();
      await page.locator('#vHeadCondition').selectOption(headCondition);
      await page.locator('#vSession').fill('1');
      if(headCondition==='free') assert((await page.locator('#validationHeadNote').innerText()).includes('参考値'));
      await page.locator('#vPositionConfirmed').check();
      await page.locator('#validationPrepareBtn').click();
      await page.clock.runFor(100);
      await page.waitForFunction(()=>!document.getElementById('validationSetup').open, null, {polling:20});
      for(const id of [1,2,3,4,6,7,8,9,5]) {
        await page.evaluate(id=>{
          const p=document.getElementById('Pt'+id);
          window.__gaze={x:parseFloat(p.style.left)/100,y:parseFloat(p.style.top)/100};
        },id);
        await page.clock.runFor(350);
        for(let i=0;i<5;i++) await page.locator('#Pt'+id).click();
      }
      assert.equal(await page.locator('#validationRunBtn').isDisabled(),true);
      await page.clock.runFor(5300);
      assert.equal(await page.locator('#validationRunBtn').isEnabled(),true,await page.locator('#validationStatus').innerText());
      assert.equal(await page.evaluate(()=>trackerBridge.status().correctionApplied),false);
      if(withCorrection) {
        await page.locator('#correctionBtn').click();
        assert.equal(await page.locator('#validationRunBtn').isDisabled(),true);
        await page.clock.runFor(17500);
        assert.equal(await page.locator('#validationRunBtn').isEnabled(),true,await page.locator('#validationStatus').innerText());
        assert.equal(await page.evaluate(()=>trackerBridge.status().correctionApplied),true);
      }
    }
    await calibrate();
    const snapshot=await page.evaluate(()=>{const s=trackerBridge.acquire();trackerBridge.release();return s;});
    // Leaving fullscreen before the run must not leave Start permanently disabled.
    await page.evaluate(()=>document.exitFullscreen());
    await page.clock.runFor(100);
    assert.equal(await page.locator('#validationRunBtn').isEnabled(),true);
    assert((await page.locator('#validationStatus').innerText()).includes('全画面が解除'));
    await page.locator('#validationRunBtn').click();
    await page.clock.runFor(4000);
    assert.equal(await page.locator('#resetBtn').isDisabled(),true);
    assert.equal(await page.locator('#gazeDot').evaluate(e=>getComputedStyle(e).visibility),'hidden');
    assert.equal(await page.evaluate(()=>{try{trackerBridge.prepare();return false;}catch{return true;}}),true);
    await page.screenshot({path:path.join(artifacts,'target-desktop.png')});
    for(let i=0;i<8;i++) await page.clock.runFor(10000);
    await page.clock.runFor(1000);
    await page.waitForFunction(()=>document.getElementById('validationSaveStatus').textContent.includes('保存済み'));
    assert.equal(bundles.length,1);
    const complete=bundles[0];
    assert.equal(complete.metadata.head_condition,'fixed');
    assert.equal(complete.metadata.angular_error_reference,'initial_centered_eye_position_and_declared_distance');
    assert.equal(complete.metadata.tracker.five_point_correction_applied,false);
    assert.equal(complete.summary.status,'completed');
    assert.equal(complete.summary.data_complete,true);
    assert.equal(complete.summary.trials.length,27);
    assert(complete.frames.some(f=>f.failure_reason==='no_face'));
    assert(complete.frames.every(f=>f.frame_source==='requestVideoFrameCallback'));
    assert(complete.frames.every(f=>f.target_x!==undefined && f.raw_error_deg!==undefined));
    assert(complete.summary.positions.every(p=>p.trials_with_data===3));
    assert.equal(await page.locator('#validationRunBtn').isEnabled(),true);
    assert.deepEqual(snapshot.regression,complete.metadata.tracker.regression);
    assert.equal(await page.evaluate(()=>document.fullscreenElement===null),true);
    await page.screenshot({path:path.join(artifacts,'results-desktop.png')});
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#validationResults').evaluate(e=>e.open),false);
    await page.locator('#validationResultsBtn').click();
    assert((await page.locator('#validationSummary').innerText()).includes('頭部固定'));
    await page.keyboard.press('Escape');

    await page.locator('#validationRunBtn').click();
    assert.equal(await page.locator('#validationSetup').evaluate(e=>e.open),true);
    assert.equal(bundles.length,1); // completed calibration cannot silently be reused
    await page.locator('#validationSetupClose').click();

    await calibrate(true,'free');
    failSave=true;
    await page.locator('#validationRunBtn').click();
    await page.clock.runFor(4600);
    await page.evaluate(()=>document.exitFullscreen());
    await page.clock.runFor(100);
    await page.waitForFunction(()=>document.getElementById('validationSaveStatus').textContent.includes('自動保存できません'));
    const interrupted=bundles[1];
    assert.equal(interrupted.metadata.head_condition,'free');
    assert((await page.locator('#validationAngleNote').innerText()).includes('参考値'));
    assert.equal(interrupted.metadata.tracker.five_point_correction_applied,true);
    assert.equal(interrupted.summary.status,'aborted');
    assert(interrupted.frames.length>0);
    assert(interrupted.frames.every(f=>!f.included_in_analysis));
    failSave=false;
    await page.locator('#validationSaveBtn').click();
    await page.waitForFunction(()=>document.getElementById('validationSaveStatus').textContent.includes('保存済み'));
    assert.equal(bundles[2].metadata.run_id,interrupted.metadata.run_id);
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#validationJsonBtn').click();
    const download=await downloadPromise;
    assert.equal(JSON.parse(fs.readFileSync(await download.path(),'utf8')).metadata.run_id,interrupted.metadata.run_id);
    await page.locator('#validationCompareInput').setInputFiles([
      {name:'first.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(complete))},
      {name:'second.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(interrupted))}]);
    await page.waitForFunction(()=>document.querySelectorAll('#validationCompareRows tr').length===2);
    assert((await page.locator('#validationCompareRows').innerText()).includes('頭部非固定'));
    assert(!(await page.locator('#validationCompareStatus').innerText()).includes('同じ回の複数実行'));
    const corrected=JSON.parse(JSON.stringify(complete));
    corrected.metadata.run_id='corrected-condition'; corrected.metadata.session_number=3;
    corrected.metadata.tracker.five_point_correction_applied=true;
    await page.locator('#validationCompareInput').setInputFiles([
      {name:'first.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(complete))},
      {name:'corrected.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(corrected))}]);
    await page.waitForFunction(()=>document.getElementById('validationCompareStatus').textContent.includes('条件またはコード版が異なる'));
    const different=JSON.parse(JSON.stringify(complete));
    different.metadata.run_id='different-conditions'; different.metadata.session_number=3; different.metadata.geometry.width_cm=50;
    await page.locator('#validationCompareInput').setInputFiles([
      {name:'first.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(complete))},
      {name:'different.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(different))}]);
    await page.waitForFunction(()=>document.getElementById('validationCompareStatus').textContent.includes('条件またはコード版が異なる'));
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(artifacts,'results-mobile.png')});
    const analysisPage=await browser.newPage({viewport:{width:1280,height:900}});
    analysisPage.on('pageerror',error=>errors.push(error.message));
    await analysisPage.goto(new URL('analysis.html',process.env.VALIDATION_URL || 'http://localhost:8000/').href);
    await analysisPage.locator('#csvInput').setInputFiles({name:'validation.csv',mimeType:'text/csv',buffer:Buffer.from('run_id,x,y\ntest,100,100')});
    await analysisPage.waitForFunction(()=>document.getElementById('analysisStatus').textContent.includes('正確度検証のCSV'));
    await analysisPage.locator('#csvInput').setInputFiles({name:'normal.csv',mimeType:'text/csv',buffer:Buffer.from(
      'elapsed_ms,phase,x,y,distance_px,speed_px_per_second,screen_width,screen_height\n0,test,100,100,0,0,1920,1080\n30,test,101,100,1,33,1920,1080')});
    await analysisPage.waitForFunction(()=>document.getElementById('analysisStatus').textContent.includes('normal.csv を読み込みました'));
    assert.equal(await analysisPage.locator('#resultsPanel').isVisible(),true);
    await analysisPage.close();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',checks:['Start opens missing setup','Start restores fullscreen','completed run requires fresh setup','9-point calibration without correction','optional 5-point correction','head condition selection/metadata/comparison','automatic fullscreen exit','Escape closes and reopens results','correction mode metadata/comparison','27 trials','frozen regression','failed frames','fullscreen interruption','save retry','JSON download','comparison','responsive layout'],artifacts}));
  } catch(error) {
    await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});
    console.error('Artifacts:',artifacts);
    throw error;
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
