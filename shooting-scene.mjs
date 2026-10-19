import * as THREE from './sites/pistol-range/dist/vendor/three.module.js';

export function createShootingScene(canvas, width, height) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#829098');
  scene.fog = new THREE.Fog('#829098', 15, 38);
  const camera = new THREE.PerspectiveCamera(65, width / height, .02, 80);
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


  const ray = new THREE.Raycaster(), center = new THREE.Vector2();
  let recoil = 0, flashUntil = 0;
  target.visible = false;
  function pose() {
    camera.updateMatrixWorld();
    const p = target.position.clone().project(camera);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(.42);
    const edge = target.position.clone().add(right).project(camera);
    const depth = new THREE.Vector3().subVectors(target.position, camera.position).applyQuaternion(camera.quaternion.clone().invert()).z;
    return { camera_x: camera.position.x, camera_y: camera.position.y, camera_z: camera.position.z,
      qx: camera.quaternion.x, qy: camera.quaternion.y, qz: camera.quaternion.z, qw: camera.quaternion.w,
      yaw: camera.rotation.y, pitch: camera.rotation.x, fov_deg: camera.fov,
      target_x: target.position.x, target_y: target.position.y, target_z: target.position.z, target_radius: .42,
      screen_x: (p.x + 1) * width / 2, screen_y: (1 - p.y) * height / 2,
      screen_radius_px: Math.abs(edge.x - p.x) * width / 2,
      in_view: depth < 0 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1 };
  }
  return {
    reset() { camera.rotation.set(0, 0, 0); recoil = 0; target.visible = false; },
    look(dx, dy, sensitivity) {
      camera.rotation.y = THREE.MathUtils.clamp(camera.rotation.y - dx * sensitivity, -.85, .85);
      camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - dy * sensitivity, -.45, .5);
    },
    newTarget(random, first = false) {
      camera.updateMatrixWorld();
      let point;
      for (let i = 0; i < 300; i++) {
        const u = first ? .5 : .18 + random() * .64;
        const v = first ? .5 : .18 + random() * .57;
        if (!first && u > .63 && v > .56) continue;
        if (!first && Math.hypot(u - .5, v - .5) < .17) continue;
        const depth = first ? 12.3 : 10.8 + random() * 3.2;
        const h = Math.tan(camera.fov * Math.PI / 360) * depth;
        point = new THREE.Vector3((u * 2 - 1) * h * width / height, (1 - v * 2) * h, -depth)
          .applyQuaternion(camera.quaternion).add(camera.position);
        if (point.y >= .55 && point.y <= 6.6 && Math.abs(point.x) <= 11.8 && point.z >= -16.3 && point.z <= -.8) break;
        point = null;
      }
      if (!point) throw Error('表示可能な球の位置を作成できません。');
      target.position.copy(point); target.visible = true; target.updateMatrixWorld();
      return { x: point.x, y: point.y, z: point.z };
    },
    hit() { camera.updateMatrixWorld(); target.updateMatrixWorld(); ray.setFromCamera(center, camera); return target.visible && ray.intersectObject(target, false).length > 0; },
    shot(now) { recoil = 1; flashUntil = now + 40; },
    hideTarget() { target.visible = false; },
    pose,
    draw(now, dt = 0) {
      recoil *= Math.exp(-dt * 19); gun.position.copy(gunRest);
      gun.position.z += recoil * .055; gun.position.y += recoil * .018; gun.rotation.x = recoil * .14;
      flash.visible = now < flashUntil; renderer.render(scene, camera);
      return pose();
    },
    replay(frame) {
      camera.position.set(frame.camera_x, frame.camera_y, frame.camera_z);
      camera.quaternion.set(frame.qx, frame.qy, frame.qz, frame.qw);
      camera.fov = frame.fov_deg; camera.updateProjectionMatrix();
      target.position.set(frame.target_x, frame.target_y, frame.target_z); target.visible = frame.target_visible;
      flash.visible = false; renderer.render(scene, camera);
    },
    resize(w, h) { width = w; height = h; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); },
    dispose() {
      scene.traverse(o => { o.geometry?.dispose(); if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); });
      renderer.dispose();
    }
  };
}
