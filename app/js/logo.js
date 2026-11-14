// The On Fire mark, built in real 3D: a flame circled by an orbit, extruded by
// stacking copies of its silhouette along Z. Also drives the loading screen.
let uid = 0;
const FLAME = "M32 5c4.2 10.5 18 17.6 18 33.4a18 18 0 0 1-36 0c0-9.4 5.1-15.4 9.2-21 .9 5.9 3.6 9.1 7 10.1C29 20 29.4 12 32 5Z";
const CORE = "M32 31c2.4 4.6 8.2 7.4 8.2 13.4a8.2 8.2 0 0 1-16.4 0c0-3.9 2.1-6.4 4-8.6.6 2.6 1.9 3.9 3.4 4.4C31 37.3 31 34 32 31Z";

function face(id) {
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><defs>
    <linearGradient id="fl${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd166"/><stop offset=".45" stop-color="#ff6a2a"/><stop offset="1" stop-color="#e0174f"/></linearGradient>
    <linearGradient id="or${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7fe7ff"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#b9a3ff"/></linearGradient></defs>
    <path d="M4 44A28 8.5 0 0 1 60 44" fill="none" stroke="url(#or${id})" stroke-width="2.2" opacity=".55"/>
    <path d="${FLAME}" fill="url(#fl${id})"/>
    <path d="${CORE}" fill="#fff6dc"/>
    <path d="M4 44A28 8.5 0 0 0 60 44" fill="none" stroke="url(#or${id})" stroke-width="2.6" stroke-linecap="round"/></svg>`;
}
const side = (shade) => `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="${FLAME}" fill="${shade}"/></svg>`;

export function mountLogo(el) {
  const size = +el.dataset.size || 40, depth = +el.dataset.depth || 6, step = size * 0.012;
  el.style.setProperty("--s", size + "px");
  const stack = document.createElement("div"); stack.className = "stack";
  for (let i = depth; i >= 1; i--) {                      // back to front
    const t = i / depth, l = Math.round(42 - 30 * t);       // darker further back
    const layer = document.createElement("div"); layer.className = "layer";
    layer.style.transform = `translateZ(${-i * step}px)`;
    layer.innerHTML = side(`hsl(${12 - 4 * t} 85% ${l}%)`);
    stack.appendChild(layer);
  }
  const front = document.createElement("div"); front.className = "layer";
  front.innerHTML = face(++uid); stack.appendChild(front);
  el.replaceChildren(stack);
}

// ---- loading screen ----------------------------------------------------------
const loader = document.getElementById("loader");
document.querySelectorAll(".logo3d").forEach(mountLogo);
if (loader) {
  const host = loader.querySelector(".loader-embers");
  for (let i = 0; i < 26; i++) {
    const s = document.createElement("span");
    s.style.left = (Math.random() * 100) + "%";
    s.style.setProperty("--dx", (Math.random() * 120 - 60) + "px");
    s.style.animationDuration = (5 + Math.random() * 6) + "s";
    s.style.animationDelay = (-Math.random() * 8) + "s";
    const z = 1 + Math.random() * 2; s.style.width = s.style.height = z + "px";
    host.appendChild(s);
  }
}
const shownAt = performance.now();
export function loadStep(text, pct) {
  if (!loader) return;
  document.getElementById("loader-step").textContent = text;
  document.getElementById("loader-fill").style.width = pct + "%";
}
export function loadDone() {
  if (!loader) return;
  loadStep("Ready", 100);
  const wait = Math.max(0, 900 - (performance.now() - shownAt));   // let the mark be seen, briefly
  setTimeout(() => { loader.classList.add("done"); setTimeout(() => loader.remove(), 800); }, wait);
}
export function loadFail(msg) {
  if (!loader) return;
  loadStep(msg, 100);
  document.getElementById("loader-fill").style.background = "#ff3b30";
}
