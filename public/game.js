import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";

// ---------- Base item definitions (the only programmatic items) ----------
// mclass = mining class used for tool-target matching.
const BLOCK_TYPES = {
  grass: { name: "Grass Block", emoji: "🟩", color: "#5fae3a", topColor: "#6cc24a", mclass: "grass" },
  dirt:  { name: "Dirt",        emoji: "🟫", color: "#7a5230", mclass: "dirt" },
  stone: { name: "Stone",       emoji: "🪨", color: "#8a8d91", mclass: "stone" },
  wood:  { name: "Wood",        emoji: "🪵", color: "#6e4a26", mclass: "wood" },
  leaves:{ name: "Leaves",      emoji: "🍃", color: "#3f8f33", mclass: "leaves" },
};
// seconds to break by mining class with a bare hand
const HARDNESS = { grass: 0.4, dirt: 0.5, leaves: 0.25, wood: 1.0, stone: 2.0, crafted: 1.2 };

// Build an inventory item def from a base block type
function baseDef(typeKey) {
  const t = BLOCK_TYPES[typeKey];
  return {
    name: t.name, emoji: t.emoji, color: t.color,
    rarity: "common", category: "block", placeable: true, tool: null,
    mclass: t.mclass, description: "自然のブロック。",
  };
}

// ---------- Scene setup ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color("#87ceeb");
scene.fog = new THREE.Fog("#87ceeb", 30, 80);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(20, 40, 10);
scene.add(sun);

const controls = new PointerLockControls(camera, document.body);
scene.add(controls.getObject());
camera.position.set(8, 4, 8);

// ---------- World (voxel grid) ----------
const WORLD = 16;
const blocks = new Map(); // "x,y,z" -> { mesh, def, mclass }
const key = (x, y, z) => `${x},${y},${z}`;

const geo = new THREE.BoxGeometry(1, 1, 1);
const matCache = {};
function matForColor(color) {
  if (!matCache[color]) matCache[color] = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
  return matCache[color];
}

// Place a block from an item def
function addBlock(x, y, z, def) {
  const k = key(x, y, z);
  if (blocks.has(k)) return;
  const color = def.topColor || def.color || "#aaaaaa";
  const mesh = new THREE.Mesh(geo, matForColor(color));
  mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
  mesh.userData = { x, y, z };
  scene.add(mesh);
  blocks.set(k, { mesh, def, mclass: def.mclass || "crafted" });
}
function addBaseBlock(x, y, z, typeKey) {
  const def = baseDef(typeKey);
  if (typeKey === "grass") def.topColor = BLOCK_TYPES.grass.topColor;
  addBlock(x, y, z, def);
}

function removeBlock(k) {
  const b = blocks.get(k);
  if (!b) return null;
  scene.remove(b.mesh);
  blocks.delete(k);
  return b.def;
}

function rand(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

for (let x = 0; x < WORLD; x++)
  for (let z = 0; z < WORLD; z++) {
    addBaseBlock(x, 0, z, "dirt");
    addBaseBlock(x, 1, z, "grass");
  }
for (let x = 1; x < WORLD - 1; x++)
  for (let z = 1; z < WORLD - 1; z++) {
    const r = rand(x, z);
    if (r > 0.92) {
      addBaseBlock(x, 2, z, "stone");
    } else if (r < 0.05) {
      const h = 3;
      for (let i = 0; i < h; i++) addBaseBlock(x, 2 + i, z, "wood");
      const top = 2 + h;
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          addBaseBlock(x + dx, top, z + dz, "leaves");
          addBaseBlock(x + dx, top - 1, z + dz, "leaves");
        }
      addBaseBlock(x, top + 1, z, "leaves");
    }
  }

// ---------- Inventory ----------
const inv = new Map(); // itemKey -> { def, count }
function invKeyOf(def) { return def.name.toLowerCase().trim(); }

function addToInventory(def, n = 1) {
  const k = invKeyOf(def);
  const cur = inv.get(k);
  if (cur) cur.count += n;
  else inv.set(k, { def, count: n });
  if (!selectedKey) selectedKey = k;
  renderHotbar();
}
function consume(def, n = 1) {
  const k = invKeyOf(def);
  const cur = inv.get(k);
  if (!cur || cur.count < n) return false;
  cur.count -= n;
  if (cur.count <= 0) { inv.delete(k); if (selectedKey === k) selectedKey = inv.keys().next().value || null; }
  renderHotbar();
  return true;
}

// ---------- Held item / hotbar selection ----------
let selectedKey = null;
function selectedDef() { return selectedKey ? inv.get(selectedKey)?.def : null; }

// ---------- Tool / mining helpers ----------
const SYNONYMS = { wood: ["wood", "tree", "log", "timber", "plank"], stone: ["stone", "rock", "ore", "boulder"], dirt: ["dirt", "soil", "ground", "earth"], grass: ["grass", "turf", "sod", "dirt"], leaves: ["leaves", "leaf", "foliage", "plant"] };
function toolMultiplier(def, mclass) {
  if (!def || !def.tool || !Array.isArray(def.tool.targets)) return 1;
  const syns = SYNONYMS[mclass] || [mclass];
  for (const t of def.tool.targets)
    if (syns.some((s) => t.includes(s) || s.includes(t))) return def.tool.speed || 2;
  return 1;
}

// ---------- Raycasting ----------
const raycaster = new THREE.Raycaster();
raycaster.far = 8;
const center = new THREE.Vector2(0, 0);
function targetBlock() {
  raycaster.setFromCamera(center, camera);
  const meshes = [...blocks.values()].map((b) => b.mesh);
  const hits = raycaster.intersectObjects(meshes);
  return hits.length ? hits[0] : null;
}

// ---------- Placement ----------
function placeBlock() {
  const def = selectedDef();
  if (!def || !def.placeable) return;
  const hit = targetBlock();
  if (!hit) return;
  const n = hit.face.normal;
  const { x, y, z } = hit.object.userData;
  const nx = x + Math.round(n.x), ny = y + Math.round(n.y), nz = z + Math.round(n.z);
  if (blocks.has(key(nx, ny, nz))) return;
  // don't place into the player's own cell
  const p = controls.getObject().position;
  if (Math.floor(p.x) === nx && nz === Math.floor(p.z) && (ny === Math.floor(p.y) || ny === Math.floor(p.y) - 1)) return;
  if (!consume(def)) return;
  addBlock(nx, ny, nz, def);
}

// ---------- Mining state ----------
const mineBar = document.getElementById("mineBar");
const mineFill = document.getElementById("mineFill");
let mining = false;
let mineKeyStr = null;
let mineProgress = 0;

document.addEventListener("mousedown", (e) => {
  if (!controls.isLocked) return;
  if (e.button === 0) { mining = true; }
  else if (e.button === 2) { placeBlock(); }
});
document.addEventListener("mouseup", (e) => { if (e.button === 0) { mining = false; resetMine(); } });
document.addEventListener("contextmenu", (e) => e.preventDefault());
function resetMine() { mineKeyStr = null; mineProgress = 0; mineBar.style.display = "none"; mineFill.style.width = "0%"; }

function updateMining(dt) {
  if (!mining || !controls.isLocked || !craftEl.classList.contains("hidden")) { if (mineKeyStr) resetMine(); return; }
  const hit = targetBlock();
  if (!hit) { resetMine(); return; }
  const { x, y, z } = hit.object.userData;
  const k = key(x, y, z);
  const b = blocks.get(k);
  if (!b) { resetMine(); return; }
  if (k !== mineKeyStr) { mineKeyStr = k; mineProgress = 0; }
  const base = HARDNESS[b.mclass] ?? HARDNESS.crafted;
  const time = base / toolMultiplier(selectedDef(), b.mclass);
  mineProgress += dt;
  mineBar.style.display = "block";
  mineFill.style.width = Math.min(100, (mineProgress / time) * 100) + "%";
  if (mineProgress >= time) {
    const def = removeBlock(k);
    if (def) addToInventory(def);
    resetMine();
  }
}

// ---------- Movement ----------
const velocity = new THREE.Vector3();
const moveKeys = { forward: false, back: false, left: false, right: false, up: false, down: false };
document.addEventListener("keydown", (e) => {
  switch (e.code) {
    case "KeyW": moveKeys.forward = true; break;
    case "KeyS": moveKeys.back = true; break;
    case "KeyA": moveKeys.left = true; break;
    case "KeyD": moveKeys.right = true; break;
    case "Space": moveKeys.up = true; break;
    case "ShiftLeft": case "ShiftRight": moveKeys.down = true; break;
    case "KeyE": e.preventDefault(); toggleCraft(); break;
    default:
      if (e.code.startsWith("Digit")) selectByIndex(parseInt(e.code.slice(5), 10) - 1);
  }
});
document.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW": moveKeys.forward = false; break;
    case "KeyS": moveKeys.back = false; break;
    case "KeyA": moveKeys.left = false; break;
    case "KeyD": moveKeys.right = false; break;
    case "Space": moveKeys.up = false; break;
    case "ShiftLeft": case "ShiftRight": moveKeys.down = false; break;
  }
});
addEventListener("wheel", (e) => {
  if (!controls.isLocked) return;
  const keys = [...inv.keys()];
  if (!keys.length) return;
  let i = keys.indexOf(selectedKey);
  i = (i + (e.deltaY > 0 ? 1 : -1) + keys.length) % keys.length;
  selectedKey = keys[i]; renderHotbar();
});
function selectByIndex(i) {
  const keys = [...inv.keys()];
  if (i >= 0 && i < keys.length) { selectedKey = keys[i]; renderHotbar(); }
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const speed = 8;
  velocity.set(0, 0, 0);
  if (moveKeys.forward) velocity.z += 1;
  if (moveKeys.back) velocity.z -= 1;
  if (moveKeys.left) velocity.x -= 1;
  if (moveKeys.right) velocity.x += 1;
  if (controls.isLocked) {
    controls.moveRight(velocity.x * speed * dt);
    controls.moveForward(velocity.z * speed * dt);
    const obj = controls.getObject();
    if (moveKeys.up) obj.position.y += speed * dt;
    if (moveKeys.down) obj.position.y -= speed * dt;
    if (obj.position.y < 2.2) obj.position.y = 2.2;
  }
  updateMining(dt);
  renderer.render(scene, camera);
}
animate();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- Player handle (for discovery credit) ----------
let handle = localStorage.getItem("canon_handle") || "Explorer-" + Math.floor(1000 + (Date.now() % 9000));
const handleInput = document.getElementById("handleInput");
handleInput.value = handle;
function saveHandle() {
  handle = (handleInput.value || "").trim().slice(0, 24) || handle;
  localStorage.setItem("canon_handle", handle);
}

// ---------- UI: start ----------
const startEl = document.getElementById("start");
document.getElementById("startBtn").addEventListener("click", () => { saveHandle(); controls.lock(); });
controls.addEventListener("lock", () => startEl.classList.add("hidden"));
controls.addEventListener("unlock", () => {
  // Only show the start screen for a genuine release (Esc). Opening the
  // craft modal also unlocks, but we don't want the start screen then.
  if (crafting) return;
  startEl.classList.remove("hidden");
});

// ---------- visuals helper ----------
function iconHTML(def, cls = "emoji") {
  return def.image ? `<img src="${def.image}" alt="">` : `<span class="${cls}">${def.emoji}</span>`;
}
function tagText(def) {
  if (def.category === "tool" && def.tool) return `ツール ⛏x${def.tool.speed}`;
  if (def.placeable) return "設置可";
  return def.category || "";
}

// ---------- UI: hotbar ----------
const hotbar = document.getElementById("hotbar");
const heldLabel = document.getElementById("heldLabel");
function renderHotbar() {
  hotbar.innerHTML = "";
  let idx = 0;
  for (const [k, { def, count }] of inv) {
    idx++;
    const el = document.createElement("div");
    el.className = "hb-slot" + (k === selectedKey ? " active" : "");
    el.innerHTML = `${iconHTML(def)}<span class="count">${count}</span>`;
    el.title = `${def.name} — ${tagText(def)}`;
    el.addEventListener("click", () => { selectedKey = k; renderHotbar(); });
    hotbar.appendChild(el);
  }
  const d = selectedDef();
  heldLabel.textContent = d ? `${d.name}（${tagText(d)}）` : "";
}

// ---------- UI: crafting ----------
const craftEl = document.getElementById("craft");
const invGrid = document.getElementById("invGrid");
const slotA = document.getElementById("slotA");
const slotB = document.getElementById("slotB");
const slotR = document.getElementById("slotR");
const craftBtn = document.getElementById("craftBtn");
const craftMsg = document.getElementById("craftMsg");
let selA = null, selB = null;
let crafting = false; // true while craft modal is the reason for unlock

function toggleCraft() {
  if (craftEl.classList.contains("hidden")) openCraft();
  else closeCraft();
}
function openCraft() {
  crafting = true;
  controls.unlock();
  startEl.classList.add("hidden");
  craftEl.classList.remove("hidden");
  selA = selB = null;
  setSlot(slotR, null);
  craftMsg.textContent = "";
  renderInv();
  updateSlots();
}
function closeCraft() {
  craftEl.classList.add("hidden");
  crafting = false;
  // Re-lock so WASD/mouse work again. Triggered from a user gesture
  // (E keypress or button click) so the browser allows it.
  controls.lock();
}
document.getElementById("closeCraft").addEventListener("click", closeCraft);

function renderInv() {
  invGrid.innerHTML = "";
  if (inv.size === 0) {
    invGrid.innerHTML = "<p style='grid-column:1/-1;opacity:.6'>まだ何も持っていない。ブロックを壊そう。</p>";
    return;
  }
  for (const [k, { def, count }] of inv) {
    const el = document.createElement("div");
    el.className = "inv-item" + (selA === k || selB === k ? " selected" : "");
    el.innerHTML = `${iconHTML(def)}<span class="count">x${count}</span><span class="name">${def.name}</span><span class="tags">${tagText(def)}</span>`;
    el.addEventListener("click", () => pickItem(k));
    invGrid.appendChild(el);
  }
}

function pickItem(k) {
  if (selA === k) selA = null;
  else if (selB === k) selB = null;
  else if (!selA) selA = k;
  else if (!selB) selB = k;
  else selB = k;
  renderInv();
  updateSlots();
}

function defByKey(k) { return k ? inv.get(k)?.def : null; }

function setSlot(el, def) {
  if (!def) { el.innerHTML = `<span>${el === slotR ? "?" : "素材"}</span>`; return; }
  el.innerHTML = `${iconHTML(def, "big")}<span class="${def.rarity ? "rarity-" + def.rarity : ""}">${def.name}</span><span class="tags">${tagText(def)}</span>`;
}
function updateSlots() {
  const a = defByKey(selA), b = defByKey(selB);
  setSlot(slotA, a);
  setSlot(slotB, b);
  craftBtn.disabled = !(a && b);
}

craftBtn.addEventListener("click", async () => {
  const a = defByKey(selA), b = defByKey(selB);
  if (!a || !b) return;
  if (selA === selB && inv.get(selA).count < 2) {
    craftMsg.textContent = "同じアイテムを組み合わせるには2個必要。";
    return;
  }
  craftBtn.disabled = true;
  craftMsg.textContent = "AI が新しいアイテムを考えています…（画像生成のため数秒）";
  try {
    const res = await fetch("/api/craft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: stripDef(a), b: stripDef(b), handle }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "craft failed");
    const r = data.result;
    consume(a); consume(b);
    addToInventory(r);
    setSlot(slotR, r);
    const first = data.discovery?.first;
    craftMsg.innerHTML =
      `✨ <b class="rarity-${r.rarity}">${r.emoji} ${r.name}</b>（${r.rarity} / ${tagText(r)}）` +
      `<br><small>${r.description || ""}</small>` +
      `<br><small style="opacity:.5">${first
        ? "🌍 世界初の組み合わせ！正史に刻まれました"
        : `既知の組み合わせ（発見者: ${data.discovery?.by || "?"}）`}</small>`;
    if (first) { celebrate(r); refreshFeed(); }
    selA = selB = null;
    renderInv();
    updateSlots();
  } catch (e) {
    craftMsg.textContent = "エラー: " + e.message;
    craftBtn.disabled = false;
  }
});

// only send fields the LLM should reason over
function stripDef(d) {
  return { name: d.name, emoji: d.emoji, color: d.color, rarity: d.rarity, category: d.category, placeable: d.placeable, tool: d.tool, description: d.description };
}

// ---------- World-first celebration ----------
const firstToast = document.getElementById("firstToast");
let toastTimer = null;
function celebrate(r) {
  firstToast.innerHTML =
    `<span class="big">🌍 世界初の発見！</span>${r.emoji} <b>${r.name}</b><br>` +
    `<small>あなた（${handle}）が世界で初めてこれを生み出しました</small>`;
  firstToast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => firstToast.classList.add("hidden"), 4500);
}

// ---------- Live discovery feed ----------
const feedList = document.getElementById("feedList");
async function refreshFeed() {
  try {
    const res = await fetch("/api/feed");
    const { feed } = await res.json();
    feedList.innerHTML = feed.map((f) =>
      `<div class="feed-item"><span class="rarity-${f.rarity}">${f.emoji} ${f.name}</span>` +
      `<br><span class="who">— ${f.by}</span></div>`).join("") ||
      "<div class='feed-item' style='opacity:.5'>まだ発見なし。一番乗りを狙え。</div>";
  } catch { /* ignore */ }
}
refreshFeed();
setInterval(refreshFeed, 15000);

renderHotbar();
