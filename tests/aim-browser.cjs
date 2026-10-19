// Synthetic camera only. All save requests are intercepted; no research records are written.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  const page=await browser.newPage({viewport:{width:1440,height:1000},screen:{width:1920,height:1080},acceptDownloads:true});
  const errors=[], payloads=[]; let failSave=true;
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'gaze-aim-ui-'));
  page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.route('**/save-aim',async route=>{
      const body=route.request().postDataJSON(); payloads.push(body);
      await route.fulfill({status:failSave?500:200,contentType:'application/json',body:JSON.stringify(failSave?
        {ok:false,error:'Simulated failure'}:{ok:true,path:`recordings/aim/${body.run_id}`})});
    });
    await page.route('**/save-validation',route=>route.abort());
    await page.route('**/mediapipe/face_mesh/face_mesh.js',route=>route.fulfill({contentType:'text/javascript',body:`
      window.FaceMesh=class {
        setOptions(){} async initialize(){} onResults(fn){this.callback=fn;}
        async send(){
          window.__fakeFrames=(window.__fakeFrames||0)+1;
          if(window.__fakeFrames%13===0){this.callback({multiFaceLandmarks:[]});return;}
          const gaze=window.__gaze||{x:0.5,y:0.5};
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
      for(const [name,get] of Object.entries({readyState:()=>4,videoWidth:()=>1280,videoHeight:()=>720,currentTime:()=>Math.floor(performance.now()/33)/30}))
        Object.defineProperty(HTMLVideoElement.prototype,name,{get,configurable:true});
      HTMLVideoElement.prototype.play=async()=>{};
      HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){return requestAnimationFrame(now=>callback(now,{
        mediaTime:Math.floor(performance.now()/33)/30,presentedFrames:Math.floor(performance.now()/33),expectedDisplayTime:now}));};
      HTMLVideoElement.prototype.cancelVideoFrameCallback=id=>cancelAnimationFrame(id);
    });
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now()+1000));
    await page.goto(process.env.VALIDATION_URL || 'http://localhost:8000/');
    await page.locator('#aimSetupBtn').click(); await page.locator('#aConfirmed').check();
    await page.locator('#aimPrepareBtn').click();
    assert((await page.locator('#aimSetupError').innerText()).includes('カメラ'));
    await page.locator('#aimSetupClose').click(); await page.locator('#startBtn').click(); await page.clock.runFor(500);
    async function calibrate(head='fixed') {
      await page.locator('#aimSetupBtn').click();
      await page.locator('#aHead').selectOption(head); await page.locator('#aConfirmed').check();
      await page.locator('#aCount').fill('3'); await page.locator('#aSeed').fill('42');
      await page.screenshot({path:path.join(artifacts,`setup-${head}.png`)});
      await page.locator('#aimPrepareBtn').click(); await page.clock.runFor(100);
      await page.waitForFunction(()=>!document.getElementById('aimSetup').open,null,{polling:20});
      for(const id of [1,2,3,4,6,7,8,9,5]) {
        await page.evaluate(id=>{const p=document.getElementById('Pt'+id);window.__gaze={x:parseFloat(p.style.left)/100,y:parseFloat(p.style.top)/100};},id);
        await page.clock.runFor(350);
        for(let i=0;i<5;i++) await page.locator('#Pt'+id).click();
      }
      assert.equal(await page.locator('#aimRunBtn').isDisabled(),true);
      await page.clock.runFor(5300);
      assert.equal(await page.locator('#aimRunBtn').isEnabled(),true,await page.locator('#aimStatus').innerText());
    }
    async function target(n) {
      for(let i=0;i<100;i++) {
        if(await page.evaluate(n=>!document.getElementById('aimTarget').hidden && document.getElementById('aimProgress').textContent.startsWith(n+' /'),n))
          return page.locator('#aimTarget').evaluate(e=>({x:parseFloat(e.style.left),y:parseFloat(e.style.top)}));
        await page.clock.runFor(50);
      }
      throw new Error(`Target ${n} did not appear`);
    }
    await calibrate();
    const snapshot=await page.evaluate(()=>{const s=trackerBridge.acquire();trackerBridge.release();return s;});
    await page.locator('#aimRunBtn').click();
    assert.equal(await page.locator('#resetBtn').isDisabled(),true);
    assert.equal(await page.locator('#validationSetupBtn').isDisabled(),true);
    assert.equal(await page.locator('#gazeDot').evaluate(e=>getComputedStyle(e).visibility),'hidden');
    await page.mouse.click(5,5); // countdown click is retained but not a miss on a target
    let t=await target(1); await page.clock.runFor(200);
    await page.mouse.move(100,100);await page.clock.runFor(20);
    await page.mouse.move(200,120);await page.clock.runFor(20);
    await page.mouse.click(5,5);
    await page.clock.runFor(200); await page.mouse.click(t.x,t.y);
    assert.equal(await page.locator('#aimTarget').evaluate(e=>e.hidden),true);
    await target(2); await page.clock.runFor(3100); // timeout
    t=await target(3);
    await page.evaluate(t=>{window.__gaze={x:t.x/innerWidth,y:t.y/innerHeight};},t);
    await page.clock.runFor(400); await page.screenshot({path:path.join(artifacts,'target.png')});
    await page.mouse.click(t.x,t.y); await page.clock.runFor(100);
    await page.waitForFunction(()=>document.getElementById('aimSaveStatus').textContent.includes('自動保存できません'));
    const complete=JSON.parse(payloads[0].files['session.json']);
    assert.equal(Object.keys(payloads[0].files).length,5);assert(payloads[0].files['cursor.csv'].includes('sample_kind'));
    assert(complete.cursor.filter(p=>p.sample_kind==='move' && p.trial_id===1).length>=2);
    assert.equal(complete.cursor.filter(p=>p.sample_kind==='button_down').length,complete.clicks.length);
    assert(complete.cursor.some(p=>p.trial_id===null));
    assert(complete.cursor.every(p=>p.time_ms>=complete.metadata.start_ms && p.time_ms<=complete.metadata.end_ms));
    assert.equal(complete.summary.status,'completed'); assert.equal(complete.summary.hits,2);
    assert.equal(complete.summary.timeouts,1); assert.equal(complete.summary.miss_clicks,1);
    assert.equal(complete.summary.outside_window_clicks,1);
    assert(complete.trials[0].hit_response_ms>complete.trials[0].first_click_ms);
    assert(complete.gaze.some(f=>f.valid && f.trial_id===1)); assert(complete.gaze.some(f=>f.failure_reason==='no_face'));
    assert.deepEqual(complete.metadata.tracker.regression,snapshot.regression);
    assert.equal(complete.metadata.head_condition,'fixed'); assert.equal(complete.metadata.tracker.five_point_correction_applied,false);
    assert.equal(await page.evaluate(()=>document.fullscreenElement===null),true);
    assert(await page.locator('#aimTrajectory line').count()>0);
    assert(await page.locator('#aimTrajectory .cursor-path').count()>0);
    await page.locator('#aimCursorToggle').uncheck();assert.equal(await page.locator('#aimTrajectory .cursor-path').count(),0);
    await page.locator('#aimCursorToggle').check();
    const cursorPromise=page.waitForEvent('download');await page.locator('#aimCursorBtn').click();
    const cursorDownload=await cursorPromise;assert(fs.readFileSync(await cursorDownload.path(),'utf8').includes('button_down'));
    await page.locator('#aimTrialSelect').selectOption('3'); await page.locator('#aimRawToggle').check();
    assert((await page.locator('#aimTrialInfo').innerText()).includes('未加工'));
    failSave=false; await page.locator('#aimSaveBtn').click();
    await page.waitForFunction(()=>document.getElementById('aimSaveStatus').textContent.includes('保存済み'));
    assert.deepEqual(payloads[0],payloads[1]);
    await page.screenshot({path:path.join(artifacts,'results.png')});
    const promise=page.waitForEvent('download'); await page.locator('#aimJsonBtn').click();
    const download=await promise;
    assert.equal(JSON.parse(fs.readFileSync(await download.path(),'utf8')).metadata.run_id,complete.metadata.run_id);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#aimResults').evaluate(e=>e.open),false);
    await calibrate('free'); await page.locator('#aimRunBtn').click(); await target(1); await page.clock.runFor(250);
    await page.keyboard.press('Escape'); await page.clock.runFor(100);
    await page.waitForFunction(()=>document.getElementById('aimSaveStatus').textContent.includes('保存済み'));
    const aborted=JSON.parse(payloads[2].files['session.json']);
    assert(Array.isArray(aborted.cursor));
    assert.equal(aborted.summary.status,'aborted'); assert.equal(aborted.trials[0].status,'aborted');
    assert.equal(aborted.metadata.head_condition,'free'); assert(aborted.gaze.length>0);
    assert.equal(await page.locator('#resetBtn').isEnabled(),true);
    await page.locator('#aimImport').setInputFiles({name:'session.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(complete))});
    await page.waitForFunction(()=>document.getElementById('aimTrialRows').children.length===3);
    assert((await page.locator('#aimSummary').innerText()).includes('命中 2/3'));
    assert.equal(await page.locator('#aimCursorBtn').isEnabled(),true);
    const legacy=JSON.parse(JSON.stringify(complete));delete legacy.cursor;delete legacy.metadata.cursor_recording;
    await page.locator('#aimImport').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});
    await page.waitForFunction(()=>document.getElementById('aimSaveStatus').textContent.includes('legacy.json'));
    assert.equal(await page.locator('#aimCursorBtn').isDisabled(),true);
    assert((await page.locator('#aimTrialInfo').innerText()).includes('カーソル移動データがありません'));
    await page.locator('#aimImport').setInputFiles({name:'wrong.json',mimeType:'application/json',buffer:Buffer.from('{"schema":"wrong"}')});
    await page.waitForFunction(()=>document.getElementById('aimImportError').textContent.includes('JSONではありません'));
    await page.setViewportSize({width:390,height:844}); await page.screenshot({path:path.join(artifacts,'results-mobile.png')});
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#aimResults').evaluate(e=>e.open),false);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',checks:['real tracker bridge with synthetic camera','9-point calibration without correction','hit/miss/timeout','shared gaze/click clock','frozen model','missing gaze','save retry/download/import','trajectory','Escape abort and close','head conditions','responsive layout'],artifacts}));
  } catch(error) {
    await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});
    console.error('Artifacts:',artifacts); throw error;
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
