const $ = (s) => document.querySelector(s);
const CIRC = 678.6;          // ring circumference (2 * PI * 108)
const SHIFT_SECONDS = 8 * 3600;

let sb;                      // Supabase client (auth only)
let session = null;
let state = { profile: null, open: null, recent: [], skew: 0 };
let timer = null;
let busy = false;
let signUpMode = false;

/* ---------- helpers ---------- */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const hhmmss = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
const hm = (min) => `${Math.floor(min / 60)}h ${pad(Math.round(min % 60))}m`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const nowMs = () => Date.now() + state.skew; // corrected toward server time

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { await sb.auth.signOut(); throw new Error("Session expired. Please sign in again."); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Something went wrong. Try again.");
  }
  return res;
}

function setMsg(el, text, isError = false) {
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  });
}

/* ---------- auth ---------- */
async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  let cfg;
  try {
    cfg = await (await fetch("/api/config")).json();
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error("missing");
  } catch {
    showAuth();
    setMsg($("#auth-msg"), "App is not configured yet. Set the Supabase environment variables in Netlify.", true);
    return;
  }
  sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((event, s) => {
    const changed = (s?.user?.id || null) !== (session?.user?.id || null);
    session = s;
    if (changed || event === "SIGNED_OUT") route();
  });
  route();
}

function showAuth() {
  clearInterval(timer);
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
}

async function route() {
  if (!session) return showAuth();
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
  await refresh();
}

function setAuthMode(signUp) {
  signUpMode = signUp;
  $("#auth-title").textContent = signUp ? "Create account" : "Sign in";
  $("#auth-submit").textContent = signUp ? "Create account" : "Sign in";
  $("#auth-toggle").textContent = signUp ? "Have an account? Sign in" : "New here? Create an account";
  $("#name-field").hidden = !signUp;
  $("#password").autocomplete = signUp ? "new-password" : "current-password";
  setMsg($("#auth-msg"), "");
}

$("#auth-toggle").addEventListener("click", () => setAuthMode(!signUpMode));

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#auth-submit");
  btn.disabled = true;
  setMsg($("#auth-msg"), "");
  const email = $("#email").value.trim();
  const password = $("#password").value;
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name: $("#name").value.trim() } } });
      if (error) throw error;
      if (!data.session) setMsg($("#auth-msg"), "Check your email to confirm your account, then sign in.");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    setMsg($("#auth-msg"), err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("#signout").addEventListener("click", () => sb.auth.signOut());

/* ---------- employee view ---------- */
async function refresh() {
  try {
    const res = await api("/api/clock");
    const data = await res.json();
    state.profile = data.profile;
    state.open = data.open;
    state.recent = data.recent;
    state.skew = new Date(data.serverTime).getTime() - Date.now();
    renderClock();
  } catch (err) {
    setMsg($("#clock-msg"), err.message, true);
  }
}

function renderClock() {
  const p = state.profile;
  $("#hello").textContent = `Hi, ${p.name || "there"}`;
  $("#today").textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  $("#tabs").hidden = p.role !== "manager";

  const on = !!state.open;
  const dial = $("#punch");
  dial.classList.toggle("on", on);
  $("#dial-label").textContent = on ? "Clock out" : "Clock in";
  $("#status").textContent = on ? `Clocked in at ${fmtTime(state.open.clock_in)}` : "Not clocked in";

  renderRecent();
  clearInterval(timer);
  tick();
  timer = setInterval(tick, 1000);
}

function elapsedSeconds() {
  return state.open ? Math.max(0, Math.floor((nowMs() - new Date(state.open.clock_in).getTime()) / 1000)) : 0;
}

function tick() {
  const sec = elapsedSeconds();
  $("#dial-time").textContent = hhmmss(sec);
  const frac = state.open ? Math.min(sec / SHIFT_SECONDS, 1) : 0;
  $("#progress").style.strokeDashoffset = String(CIRC * (1 - frac));
  updateSummary();
}

function updateSummary() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  let todayMin = 0, totalMin = 0;
  for (const e of state.recent) {
    const mins = e.clock_out ? e.duration_minutes : (nowMs() - new Date(e.clock_in).getTime()) / 60000;
    totalMin += mins;
    if (new Date(e.clock_in) >= midnight) todayMin += mins;
  }
  $("#sum-today").textContent = hm(todayMin);
  $("#sum-week").textContent = hm(totalMin);
}

function renderRecent() {
  const ul = $("#recent");
  if (!state.recent.length) {
    ul.innerHTML = '<li class="empty">No shifts yet. Tap Clock in to start your first one.</li>';
    return;
  }
  ul.innerHTML = state.recent.map((e) => `
    <li>
      <div>
        <div class="when">${esc(fmtDay(e.clock_in))}</div>
        <div class="range">${esc(fmtTime(e.clock_in))} – ${e.clock_out ? esc(fmtTime(e.clock_out)) : "now"}</div>
      </div>
      <div class="dur ${e.clock_out ? "" : "live"}">${e.clock_out ? hm(e.duration_minutes) : "Running"}</div>
    </li>`).join("");
}

$("#punch").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  const dial = $("#punch");
  dial.disabled = true;
  const action = state.open ? "out" : "in";
  setMsg($("#clock-msg"), "Checking your location…");
  try {
    const pos = await getPosition();
    setMsg($("#clock-msg"), "");
    await api("/api/clock", { method: "POST", body: JSON.stringify({ action, ...pos }) });
    await refresh();
    setMsg($("#clock-msg"), action === "in" ? "Clocked in." : "Clocked out.");
  } catch (err) {
    setMsg($("#clock-msg"), err.message, true);
  } finally {
    busy = false;
    dial.disabled = false;
  }
});

/* ---------- manager view ---------- */
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    const team = t.dataset.tab === "team";
    $("#clock-view").hidden = team;
    $("#team-view").hidden = !team;
    if (team) loadTeam();
  })
);

function range() {
  const f = $("#from").value, t = $("#to").value;
  const q = new URLSearchParams();
  if (f) q.set("from", new Date(f + "T00:00:00").toISOString());
  if (t) { const end = new Date(t + "T00:00:00"); end.setDate(end.getDate() + 1); q.set("to", end.toISOString()); }
  return q;
}

async function loadTeam() {
  const msg = $("#team-msg");
  if (!$("#from").value) {
    const d = new Date(); d.setDate(d.getDate() - 6);
    $("#from").value = d.toISOString().slice(0, 10);
    $("#to").value = new Date().toISOString().slice(0, 10);
  }
  setMsg(msg, "Loading…");
  try {
    const res = await api("/api/entries?" + range());
    const { entries } = await res.json();
    $("#team-body").innerHTML = entries.length
      ? entries.map((e) => `
        <tr>
          <td>${esc(e.name)}</td>
          <td>${esc(fmtDay(e.clock_in))} ${esc(fmtTime(e.clock_in))}</td>
          <td>${e.clock_out ? esc(fmtTime(e.clock_out)) : "Still in"}</td>
          <td class="r">${e.clock_out ? (e.duration_minutes / 60).toFixed(2) : ""}</td>
        </tr>`).join("")
      : '<tr><td colspan="4" class="empty">No entries in this date range.</td></tr>';
    setMsg(msg, `${entries.length} entries`);
  } catch (err) {
    setMsg(msg, err.message, true);
  }
}

$("#load-team").addEventListener("click", loadTeam);

$("#export").addEventListener("click", async () => {
  const q = range(); q.set("format", "csv");
  try {
    const res = await api("/api/entries?" + q);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: "time-entries.csv" });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setMsg($("#team-msg"), err.message, true);
  }
});

init();
