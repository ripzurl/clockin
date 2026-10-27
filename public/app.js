const $ = (s) => document.querySelector(s);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

let sb;                       // Supabase client (sign-in only)
let session = null;
let timer = null;
let busy = false;
let signUpMode = false;
let photoMode = "optional";   // off | optional | required (set by the server)

const pad = (n) => String(n).padStart(2, "0");
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const state = { profile: null, open: null, recent: [], skew: 0, month: monthKey(new Date()), person: null, people: [] };

/* ---------- helpers ---------- */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hhmmss = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
const hm = (min) => `${Math.floor(min / 60)}h ${pad(Math.round(min % 60))}m`;
const nowMs = () => Date.now() + state.skew; // corrected toward server time
const isManager = () => state.profile?.role === "manager";

function clockParts(iso) {
  if (!iso) return null;
  const s = new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  const [time, ap] = s.replace(/[\u202f\u00a0]/g, " ").split(" ");
  return { time, ap };
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, ...(opts.headers || {}) },
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

/* ---------- start-up & auth ---------- */
async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  let cfg;
  try {
    cfg = await (await fetch("/api/config")).json();
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error("missing");
    photoMode = cfg.photoMode || "optional";
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
  showView("home");
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

/* ---------- navigation ---------- */
function showView(name) {
  ["home", "history", "settings"].forEach((v) => ($(`#view-${v}`).hidden = v !== name));
  document.querySelectorAll(".nav button").forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-current", on ? "page" : "false");
  });
  window.scrollTo(0, 0);
  if (name === "history") loadHistory();
  if (name === "settings") renderSettings();
}
document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

/* ---------- camera sheet ---------- */
function toJpeg(source, w, h) {
  const scale = Math.min(1, 640 / Math.max(w, h)); // keep photos small (about 40-80 KB)
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}

async function fileToJpeg(file) {
  const bmp = await createImageBitmap(file);
  const url = toJpeg(bmp, bmp.width, bmp.height);
  if (bmp.close) bmp.close();
  return url;
}

/** Opens the camera sheet. Resolves {cancelled:true} or {photo: dataUrl}. */
function takePhoto(action) {
  return new Promise((resolve) => {
    const dlg = $("#cam"), video = $("#cam-video"), shot = $("#cam-shot"), msg = $("#cam-msg");
    const btn = { cancel: $("#cam-cancel"), skip: $("#cam-skip"), retake: $("#cam-retake"), capture: $("#cam-capture"), confirm: $("#cam-confirm") };
    const fileInput = $("#cam-file");
    let stream = null, dataUrl = null, done = false;

    const verb = action === "out" ? "clock out" : "clock in";
    $("#cam-title").textContent = `Take a selfie to ${verb}`;
    btn.confirm.textContent = `Use photo and ${verb}`;
    btn.skip.textContent = `${verb[0].toUpperCase()}${verb.slice(1)} without photo`;
    btn.skip.hidden = photoMode !== "optional";

    const stop = () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      stop();
      if (dlg.open) dlg.close();
      resolve(result);
    };
    const live = () => {
      dataUrl = null;
      shot.hidden = true;
      video.hidden = !stream;
      btn.capture.hidden = false;
      btn.retake.hidden = true;
      btn.confirm.hidden = true;
    };
    const preview = (url) => {
      dataUrl = url;
      shot.src = url;
      shot.hidden = false;
      video.hidden = true;
      btn.capture.hidden = true;
      btn.retake.hidden = false;
      btn.confirm.hidden = false;
      setMsg(msg, "");
    };

    btn.cancel.onclick = () => finish({ cancelled: true });
    btn.skip.onclick = () => finish({ photo: null });
    btn.confirm.onclick = () => finish({ photo: dataUrl });
    btn.retake.onclick = () => { live(); setMsg(msg, ""); };
    dlg.oncancel = (e) => { e.preventDefault(); finish({ cancelled: true }); };

    btn.capture.onclick = () => {
      if (stream) {
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return setMsg(msg, "The camera is still starting. Try again in a moment.");
        preview(toJpeg(video, w, h));
      } else {
        fileInput.click(); // fallback: open the phone's camera app
      }
    };
    fileInput.onchange = async () => {
      const f = fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      try { preview(await fileToJpeg(f)); }
      catch { setMsg(msg, "That photo could not be read. Please try again.", true); }
    };

    dlg.showModal();
    live();
    setMsg(msg, "Starting camera…");
    (async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return setMsg(msg, "Live camera is not available here. Tap Take photo to use your camera app.", true);
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 960 } },
          audio: false,
        });
        if (done) return stop();
        video.srcObject = stream;
        live();
        setMsg(msg, "");
      } catch {
        setMsg(msg, "Camera access is blocked. Allow it in your browser settings, or tap Take photo to use your camera app.", true);
      }
    })();
  });
}

/* ---------- home ---------- */
async function refresh() {
  try {
    const res = await api("/api/clock");
    const data = await res.json();
    state.profile = data.profile;
    state.open = data.open;
    state.recent = data.recent;
    state.skew = new Date(data.serverTime).getTime() - Date.now();
    if (!state.person) state.person = state.profile.id;
    renderHome();
  } catch (err) {
    setMsg($("#clock-msg"), err.message, true);
  }
}

/** The open shift, or today's most recent finished shift. */
function currentShift() {
  if (state.open) return state.open;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  return state.recent.find((e) => new Date(e.clock_in) >= midnight) || null;
}

function setTimeBox(sel, iso) {
  const el = $(sel);
  const p = clockParts(iso);
  el.classList.toggle("empty", !p);
  el.innerHTML = p ? `<b>${esc(p.time)}</b><small>${esc(p.ap)}</small>` : "<b>--:--</b><small>--</small>";
}

function renderHome() {
  const p = state.profile;
  $("#hello").textContent = `Hi, ${p.name || "there"}`;
  $("#today").textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  const shift = currentShift();
  setTimeBox("#t-in", shift?.clock_in);
  setTimeBox("#t-out", shift?.clock_out);

  const on = !!state.open;
  const punch = $("#punch");
  punch.textContent = on ? "Clock Out" : "Clock In";
  punch.classList.toggle("out", on);

  $("#cam-wrap").hidden = photoMode === "off";
  $("#cam-cap").textContent = on ? "Take photo to clock out" : "Take photo to clock in";

  clearInterval(timer);
  tick();
  timer = setInterval(tick, 1000);
}

function tick() {
  const el = $("#status");
  if (state.open) {
    const sec = Math.max(0, Math.floor((nowMs() - new Date(state.open.clock_in).getTime()) / 1000));
    el.textContent = `Clocked in · ${hhmmss(sec)}`;
    el.classList.add("on");
  } else {
    const shift = currentShift();
    el.textContent = shift && shift.clock_out ? `Shift finished · ${hm(shift.duration_minutes)}` : "Not clocked in";
    el.classList.remove("on");
  }
}

/** One action: take the photo, then clock in (or out) with it. */
async function clockNow() {
  if (busy) return;
  busy = true;
  const buttons = [$("#punch"), $("#cam-tile")];
  buttons.forEach((b) => (b.disabled = true));
  const action = state.open ? "out" : "in";
  try {
    let photo = null;
    if (photoMode !== "off") {
      const res = await takePhoto(action);
      if (res.cancelled) return;
      photo = res.photo;
    }
    setMsg($("#clock-msg"), "Checking your location…");
    const pos = await getPosition();
    setMsg($("#clock-msg"), "Saving…");
    const note = $("#remarks").value.trim() || null;
    await api("/api/clock", { method: "POST", body: JSON.stringify({ action, ...pos, photo, note }) });
    $("#remarks").value = "";
    await refresh();
    setMsg($("#clock-msg"), action === "in" ? "Clocked in." : "Clocked out.");
  } catch (err) {
    setMsg($("#clock-msg"), err.message, true);
  } finally {
    busy = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}
$("#cam-tile").addEventListener("click", clockNow);
$("#punch").addEventListener("click", clockNow);

/* ---------- history ---------- */
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });
}

function shiftMonth(delta) {
  const [y, m] = state.month.split("-").map(Number);
  state.month = monthKey(new Date(y, m - 1 + delta, 1));
  loadHistory();
}
$("#m-prev").addEventListener("click", () => shiftMonth(-1));
$("#m-next").addEventListener("click", () => shiftMonth(1));
$("#person").addEventListener("change", (e) => { state.person = e.target.value; loadHistory(); });

function historyQuery() {
  const q = new URLSearchParams({ month: state.month, tz: TZ });
  if (isManager() && state.person) q.set("employee", state.person);
  return q;
}

function photoThumb(url, label, eager) {
  return url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="${label} photo"><img class="thumb" loading="${eager ? "eager" : "lazy"}" src="${esc(url)}" alt="${label} photo"></a>`
    : "";
}

/** Small pin that opens the clock-in / clock-out spot in Google Maps. */
function pin(loc, label) {
  if (!loc) return "";
  const q = `${loc.lat},${loc.lng}`;
  return `<a class="pin" href="https://www.google.com/maps?q=${encodeURIComponent(q)}" target="_blank" rel="noopener" title="${esc(q)}" aria-label="${label} location on map"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>${label}</a>`;
}

async function loadHistory() {
  $("#m-label").textContent = monthLabel(state.month);
  $("#m-next").disabled = state.month >= monthKey(new Date());
  setMsg($("#h-msg"), "Loading…");
  try {
    const res = await api("/api/entries?" + historyQuery());
    const d = await res.json();

    if (isManager()) {
      state.people = d.people || [];
      const sel = $("#person");
      sel.innerHTML =
        `<option value="all">Everyone</option>` +
        state.people.map((p) => `<option value="${esc(p.id)}">${esc(p.name || "Unnamed")}${p.id === state.profile.id ? " (me)" : ""}</option>`).join("");
      sel.value = state.person;
      $("#person-wrap").hidden = false;
    } else {
      $("#person-wrap").hidden = true;
    }

    $("#h-total").textContent = d.totals.hours.toFixed(2);
    $("#h-days").textContent = String(d.totals.days);
    const showName = isManager() && state.person === "all";
    $("#h-body").innerHTML = d.entries.length
      ? d.entries.map((e, i) => {
          const text = [showName ? e.name : "", e.remarks].filter(Boolean).map(esc).join(" · ");
          const where = pin(e.inLoc, "In") + pin(e.outLoc, "Out") || '<span class="muted">No location</span>';
          return `<tr class="has-sub">
            <td><span class="d">${esc(e.day)} ${esc(e.date.slice(8))}</span></td>
            <td class="nowrap">${photoThumb(e.inPhotoUrl, "In", i < 30)}${esc(e.inTime)}</td>
            <td class="nowrap">${e.outTime ? photoThumb(e.outPhotoUrl, "Out", i < 30) + esc(e.outTime) : '<span class="live">Working</span>'}</td>
            <td class="r">${e.hours === null ? "" : e.hours.toFixed(2)}</td>
          </tr><tr class="sub-row"><td colspan="4"><span class="sub">${text ? `<span>${text}</span> ` : ""}<span class="pins">${where}</span></span></td></tr>`;
        }).join("")
      : '<tr><td colspan="4" class="empty">No clock-ins this month.</td></tr>';
    setMsg($("#h-msg"), "");
  } catch (err) {
    setMsg($("#h-msg"), err.message, true);
  }
}

$("#export").addEventListener("click", async () => {
  const btn = $("#export");
  btn.disabled = true;
  setMsg($("#h-msg"), "Preparing Excel file…");
  try {
    const res = await api("/api/export?" + historyQuery());
    const url = URL.createObjectURL(await res.blob());
    const m = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
    const a = Object.assign(document.createElement("a"), { href: url, download: m ? m[1] : `Attendance-${state.month}.xlsx` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setMsg($("#h-msg"), "Excel file downloaded.");
  } catch (err) {
    setMsg($("#h-msg"), err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- settings ---------- */
function renderSettings() {
  $("#s-name").textContent = state.profile?.name || "";
  $("#s-email").textContent = session?.user?.email || "";
  $("#s-role").textContent = isManager() ? "Manager" : "Employee";
  $("#s-tz").textContent = TZ;
  $("#s-photo").textContent = { off: "Off", optional: "Optional", required: "Required" }[photoMode] || photoMode;
}

$("#pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#pw-submit");
  btn.disabled = true;
  setMsg($("#pw-msg"), "");
  try {
    const { error } = await sb.auth.updateUser({ password: $("#new-password").value });
    if (error) throw error;
    $("#new-password").value = "";
    setMsg($("#pw-msg"), "Password updated.");
  } catch (err) {
    setMsg($("#pw-msg"), err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("#signout").addEventListener("click", () => sb.auth.signOut());

init();
