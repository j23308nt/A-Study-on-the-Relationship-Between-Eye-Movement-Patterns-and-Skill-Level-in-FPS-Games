const test=require('node:test'),assert=require('node:assert/strict'),P=require('../pupil-core.js');
const W=160,H=100;
function ellipse(g,cx,cy,a,b,value){for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(((x-cx)/a)**2+((y-cy)/b)**2<=1)g[y*W+x]=value;return g;}
function eye(background=170,pupil=20){return ellipse(new Uint8Array(W*H).fill(background),80,50,20,14,pupil);}
test('auto threshold finds a bright pupil without a manually chosen cutoff',()=>{
 const g=eye(210,120);assert(!P.detect(g,W,H,{threshold:50}).valid);
 const r=P.detectAdaptive(g,W,H);assert(r.valid);assert(Math.hypot(r.cx-80,r.cy-50)<1);assert.equal(r.threshold,120);
});
test('nested pupil is preferred over the higher contrast iris',()=>{
 const g=ellipse(ellipse(new Uint8Array(W*H).fill(170),80,50,35,26,40),86,50,12,9,20);
 const r=P.detectAdaptive(g,W,H);assert(r.valid);assert(Math.abs(r.cx-86)<1);assert(r.major<30);
});
test('partial eyelid occlusion does not force a fit to the visible region centroid',()=>{
 const g=eye();for(let y=0;y<41;y++)for(let x=0;x<W;x++)g[y*W+x]=170;
 const r=P.detectAdaptive(g,W,H);assert(r.valid);assert(Math.abs(r.cy-50)<1.5);assert(r.contour_coverage>=8/12);
});
test('central glint is rejected as an interior boundary',()=>{
 const r=P.detectAdaptive(ellipse(eye(),80,50,6,6,240),W,H);
 assert(r.valid);assert(Math.hypot(r.cx-80,r.cy-50)<1.5);assert(r.major>32);
});
test('blank, closed, edge-clipped and line-like images cannot become valid via a previous result',()=>{
 const previous=P.detectAdaptive(eye(),W,H);assert(previous.valid);
 for(const g of [new Uint8Array(W*H).fill(170),new Uint8Array(W*H).fill(10),ellipse(new Uint8Array(W*H).fill(170),3,50,20,14,20),ellipse(new Uint8Array(W*H).fill(170),80,50,30,1,20)]){
 const r=P.detectAdaptive(g,W,H,{previous});assert(!r.valid);assert(r.diagnostic);assert(!r.features);}
});
test('ambiguous separated candidates require image evidence; temporal hint may disambiguate',()=>{
 const g=ellipse(ellipse(new Uint8Array(W*H).fill(170),40,50,12,9,20),120,50,12,9,20);
 assert.equal(P.detectAdaptive(g,W,H).reason,'pupil_ambiguous');
 const r=P.detectAdaptive(g,W,H,{previous:{cx:40,cy:50,major:24}});assert(r.valid);assert(Math.abs(r.cx-40)<1);
});
test('strong eye movement can reacquire a remote pupil and fits are deterministic',()=>{
 const g=ellipse(new Uint8Array(W*H).fill(210),125,65,12,9,120),opts={previous:{cx:30,cy:25,major:24}};
 const r=P.detectAdaptive(g,W,H,opts);assert(r.valid);assert(Math.abs(r.cx-125)<1);
 assert.deepEqual(r,P.detectAdaptive(g,W,H,opts));assert.equal(r.features.length,6);
});
