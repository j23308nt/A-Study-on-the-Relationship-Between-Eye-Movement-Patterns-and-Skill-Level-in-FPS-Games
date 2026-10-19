import * as THREE from './vendor/three.module.js';
import { Session, nextTarget } from './session.js';

const canvas = document.querySelector('#game');
const button = document.querySelector('#start');
const overlay = document.querySelector('#overlay');
const hitCount = document.querySelector('#hits');
const accuracy = document.querySelector('#accuracy');
const timeLabel = document.querySelector('#time');
const marker = document.querySelector('#hitmarker');
const session = new Session();
let renderer;

try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  document.querySelector('#error').hidden = false;
  document.querySelector('#error').textContent = '3D表示を開始できません。別のブラウザで開いてください。';
  button.textContent = '再読み込み'; button.disabled = false;
  button.onclick = () => location.reload();
}

if (renderer) initialize();

function initialize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#829098');
  scene.fog = new THREE.Fog('#829098', 15, 38);
  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, .02, 80);
  camera.position.set(0, 1.65, 1.8);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  scene.add(new THREE.HemisphereLight('#eff7ff', '#56616a', 2.1));
  const sun = new THREE.DirectionalLight('#ffffff', 2.7);
  sun.position.set(-5, 10, 4); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: .5, far: 40 });
  sun.shadow.bias = -.0006;
  scene.add(sun);

  const wall = new THREE.MeshStandardMaterial({ color: '#7d8a92', roughness: 1 });
  const floorMat = new THREE.MeshStandardMaterial({ color: '#68767e', roughness: .95 });
  function box(w, h, d, x, y, z, material, parent = scene) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }
  const floor = box(32, .2, 38, 0, -.12, -9, floorMat);
  floor.receiveShadow = true;
  box(25, 8, .35, 0, 3.9, -17, wall).receiveShadow = true;
  box(.3, 8, 30, -12.5, 3.9, -3, wall);
  box(.3, 8, 30, 12.5, 3.9, -3, wall);
  const seams = new THREE.GridHelper(36, 24, '#53626b', '#53626b');
  seams.material.transparent = true; seams.material.opacity = .25;
  seams.position.set(0, -.012, -9); scene.add(seams);
  const trim = new THREE.MeshStandardMaterial({ color: '#596770', roughness: .8 });
  box(25, .16, .1, 0, .08, -16.78, trim);
  // Plain structural joints make depth readable without distracting scenery.
  for (const x of [-8, -4, 0, 4, 8]) box(.025, 7.8, .02, x, 3.9, -16.8, trim);

  const target = new THREE.Mesh(new THREE.SphereGeometry(.42, 32, 24),
    new THREE.MeshStandardMaterial({ color: '#25d2df', roughness: .36, metalness: .08 }));
  target.position.set(0, 1.65, -10.5); target.castShadow = true; scene.add(target);

  const gun = new THREE.Group(); camera.add(gun);
  const gunRest = new THREE.Vector3(.36, -.31, -.7);
  gun.position.copy(gunRest);
  const steel = new THREE.MeshStandardMaterial({ color: '#30383e', metalness: .64, roughness: .33 });
  const frameMat = new THREE.MeshStandardMaterial({ color: '#191e22', roughness: .8 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: '#66737c', metalness: .7, roughness: .3 });
  const sightMat = new THREE.MeshBasicMaterial({ color: '#c7d4d7' });
  box(.115, .12, .54, 0, .055, -.07, steel, gun);
  box(.108, .09, .38, 0, -.04, -.02, frameMat, gun);
  box(.105, .026, .51, 0, .125, -.065, edgeMat, gun);
  const grip = box(.105, .26, .135, 0, -.19, .105, frameMat, gun);
  grip.rotation.x = -.25;
  box(.11, .025, .15, 0, -.315, .135, steel, gun);
  box(.075, .025, .095, 0, -.145, -.045, steel, gun);
  box(.075, .08, .022, 0, -.1, -.09, steel, gun);
  box(.018, .065, .018, 0, -.095, -.015, frameMat, gun);
  box(.014, .027, .033, 0, .15, -.29, sightMat, gun);
  box(.075, .027, .025, 0, .15, .165, frameMat, gun);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(.031, .031, .015, 16), frameMat);
  muzzle.rotation.x = Math.PI / 2; muzzle.position.set(0, .055, -.348); gun.add(muzzle);
  for (let i = 0; i < 5; i++) box(.118, .075, .009, 0, .045, .06 + i * .017, frameMat, gun);
  const gloveMat = new THREE.MeshStandardMaterial({ color: '#515a61', roughness: 1 });
  const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), gloveMat);
  hand.scale.set(.085, .11, .12); hand.position.set(.035, -.195, .115); gun.add(hand);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(.072, .102, .6, 16), gloveMat);
  arm.position.set(.09, -.35, .35); arm.rotation.x = -.85; arm.rotation.z = -.15; gun.add(arm);
  const flash = new THREE.Mesh(new THREE.ConeGeometry(.06, .22, 6),
    new THREE.MeshBasicMaterial({ color: '#ffe4a2', transparent: true, opacity: .9 }));
  flash.rotation.x = -Math.PI / 2; flash.position.set(0, .055, -.45); flash.visible = false; gun.add(flash);

  const ray = new THREE.Raycaster();
  const center = new THREE.Vector2();
  const fragmentGeometry = new THREE.SphereGeometry(.035, 6, 4);
  const fragmentMaterial = new THREE.MeshBasicMaterial({ color: '#67edf2', transparent: true, opacity: .85 });
  const particles = [];
  let recoil = 0, yaw = 0, pitch = 0, flashUntil = 0, markerUntil = 0;
  let lastFrame = performance.now(), pendingLock = false, fallback = false;
  let touchStart = null, touchMoved = false;
  let audio;
  let soundBuffer;

  function updateHud(now = performance.now()) {
    hitCount.textContent = session.hits;
    accuracy.textContent = session.accuracy === null ? '—' : `${session.accuracy}%`;
    timeLabel.textContent = Math.ceil(session.remaining(now) / 1000);
  }
  function spawnTarget() {
    const next = nextTarget(target.position);
    target.position.set(next.x, next.y, next.z);
    target.updateMatrixWorld();
  }
  function showMenu() {
    overlay.hidden = false;
    button.textContent = session.mode === 'paused' ? '再開' : 'もう一度';
    document.body.classList.remove('playing');
  }
  function pause() {
    if (session.mode !== 'running') return;
    session.pause(performance.now());
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    updateHud(); showMenu();
  }
  function finish() {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    updateHud(); showMenu();
  }
  function activate() {
    const now = performance.now();
    if (session.mode === 'paused') session.resume(now);
    else {
      session.start(now); yaw = 0; pitch = 0;
      camera.rotation.set(0, 0, 0); target.position.set(0, 1.65, -10.5);
      target.updateMatrixWorld();
    }
    overlay.hidden = true; document.body.classList.add('playing'); updateHud(now);
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio && !audio) {
        audio = new Audio();
        soundBuffer = audio.createBuffer(1, audio.sampleRate * .075, audio.sampleRate);
        const values = soundBuffer.getChannelData(0);
        for (let i = 0; i < values.length; i++) values[i] = (Math.random() * 2 - 1) * Math.exp(-i / (audio.sampleRate * .012));
      }
      audio?.resume().catch(() => {});
    } catch { /* Sound is optional. */ }
  }
  function shotSound(hit) {
    if (!audio || audio.state !== 'running' || !soundBuffer) return;
    const noise = audio.createBufferSource(); noise.buffer = soundBuffer;
    const filter = audio.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 700;
    const gain = audio.createGain(); gain.gain.value = .18;
    noise.connect(filter).connect(gain).connect(audio.destination); noise.start();
    noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); };
    if (hit) {
      const tone = audio.createOscillator(), envelope = audio.createGain();
      tone.frequency.setValueAtTime(1500, audio.currentTime);
      tone.frequency.exponentialRampToValueAtTime(850, audio.currentTime + .055);
      envelope.gain.setValueAtTime(.035, audio.currentTime);
      envelope.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .065);
      tone.connect(envelope).connect(audio.destination); tone.start(); tone.stop(audio.currentTime + .07);
      tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
    }
  }
  function shoot() {
    const now = performance.now();
    if (session.tick(now)) { finish(); return; }
    camera.updateMatrixWorld(); target.updateMatrixWorld();
    ray.setFromCamera(center, camera);
    const hit = ray.intersectObject(target, false).length > 0;
    if (!session.shoot(now, hit)) return;
    recoil = 1; flashUntil = now + 40; shotSound(hit);
    if (hit) {
      markerUntil = now + 85;
      for (let i = 0; i < 9; i++) {
        const mesh = new THREE.Mesh(fragmentGeometry, fragmentMaterial);
        mesh.position.copy(target.position); scene.add(mesh);
        particles.push({ mesh, life: .28, velocity: new THREE.Vector3((Math.random() - .5) * 3, Math.random() * 2, (Math.random() - .5) * 3) });
      }
      spawnTarget();
    }
    updateHud(now);
  }
  function look(dx, dy) {
    if (session.mode !== 'running') return;
    yaw = THREE.MathUtils.clamp(yaw - dx * .0018, -.85, .85);
    pitch = THREE.MathUtils.clamp(pitch - dy * .0018, -.45, .5);
    camera.rotation.set(pitch, yaw, 0);
  }

  button.disabled = false; button.textContent = '開始';
  button.addEventListener('click', async () => {
    if (pendingLock) return;
    pendingLock = true; fallback = false;
    try {
      if (!canvas.requestPointerLock || matchMedia('(pointer: coarse)').matches) fallback = true;
      else {
        await canvas.requestPointerLock();
        fallback = document.pointerLockElement !== canvas;
      }
      activate();
    } catch {
      // Some embedded browsers disallow pointer lock. Relative drag/mouse input
      // still works, without blocking the entire game on a permission failure.
      fallback = true; activate();
    } finally { pendingLock = false; }
  });
  document.addEventListener('pointerlockchange', () => {
    if (!pendingLock && !fallback && document.pointerLockElement !== canvas) pause();
  });
  document.addEventListener('mousemove', event => {
    if (document.pointerLockElement === canvas || (fallback && event.target === canvas)) look(event.movementX, event.movementY);
  });
  canvas.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') {
      touchStart = { x: event.clientX, y: event.clientY, previousX: event.clientX, previousY: event.clientY };
      touchMoved = false; canvas.setPointerCapture(event.pointerId);
    } else if (event.button === 0) { event.preventDefault(); shoot(); }
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch' || !touchStart) return;
    const dx = event.clientX - touchStart.previousX, dy = event.clientY - touchStart.previousY;
    if (Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 5) touchMoved = true;
    look(dx, dy); touchStart.previousX = event.clientX; touchStart.previousY = event.clientY;
  });
  canvas.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch' && touchStart && !touchMoved) shoot();
    touchStart = null;
  });
  canvas.addEventListener('pointercancel', () => { touchStart = null; });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  document.addEventListener('keydown', event => { if (event.key === 'Escape') pause(); });
  window.addEventListener('blur', pause);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); pause();
    button.textContent = '再読み込み'; button.onclick = () => location.reload();
  });
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  renderer.setAnimationLoop(now => {
    const dt = Math.min(.05, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
    if (session.tick(now)) finish();
    if (session.mode === 'running') updateHud(now);
    recoil *= Math.exp(-dt * 19);
    gun.position.copy(gunRest); gun.position.z += recoil * .055; gun.position.y += recoil * .018;
    gun.rotation.x = recoil * .14;
    flash.visible = now < flashUntil;
    marker.classList.toggle('visible', now < markerUntil);
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i]; particle.life -= dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);
      particle.velocity.y -= dt * 4;
      particle.mesh.scale.setScalar(Math.max(0, particle.life / .28));
      if (particle.life <= 0) { scene.remove(particle.mesh); particles.splice(i, 1); }
    }
    renderer.render(scene, camera);
  });
  canvas.dataset.ready = 'true';
}
