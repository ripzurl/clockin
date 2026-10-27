import { createClient } from "@supabase/supabase-js";

export function admin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Verify the bearer token and load the caller's profile. Returns null if invalid. */
export async function authenticate(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const db = admin();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: profile } = await db
    .from("profiles")
    .select("id, name, role")
    .eq("id", data.user.id)
    .single();

  return {
    db,
    user: data.user,
    profile: profile || { id: data.user.id, name: data.user.email, role: "employee" },
  };
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Enforced on the server so it can't be bypassed from the browser. */
export function checkGeofence(lat, lng) {
  if (process.env.GEOFENCE_ENABLED !== "true") return { ok: true };

  if (typeof lat !== "number" || typeof lng !== "number") {
    return { ok: false, error: "Location is required. Allow location access and try again." };
  }
  const wLat = Number(process.env.WORK_LAT);
  const wLng = Number(process.env.WORK_LNG);
  const radius = Number(process.env.WORK_RADIUS_METERS || 150);
  const d = distanceMeters(lat, lng, wLat, wLng);

  if (d > radius) {
    return {
      ok: false,
      error: `You are about ${Math.round(d)} m from the workplace. Move within ${radius} m to clock in or out.`,
    };
  }
  return { ok: true };
}

export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A photo is mandatory for every clock in/out. Set PHOTO_MODE=off only for testing. */
export const photoMode = () => (process.env.PHOTO_MODE === "off" ? "off" : "required");

/* ---------- street address from coordinates (OpenStreetMap Nominatim) ---------- */
function formatAddress(j) {
  const a = j?.address;
  if (!a) return j?.display_name ? String(j.display_name).slice(0, 200) : null;
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const area = a.suburb || a.neighbourhood || a.quarter || a.city_district;
  const city = a.city || a.town || a.village || a.municipality || a.county;
  const parts = [a.building || a.amenity || a.office, street, area, city, a.postcode].filter(Boolean);
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  const text = unique.length ? unique.join(", ") : j.display_name || "";
  return text ? text.slice(0, 200) : null;
}

/** Returns a short address like "12 Example Road, Jurong West, Singapore 640123", or null. */
export async function reverseGeocode(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "TimeClock-Attendance/1.0", Accept: "application/json" },
    });
    if (!res.ok) return null;
    return formatAddress(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fills in missing addresses for old entries (a few per request, 1 lookup per second,
 * as the free service requires) and saves them so each place is only looked up once.
 */
export async function fillAddresses(db, rows, limit = 5) {
  const key = (l) => `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;
  const known = new Map();
  for (const r of rows) {
    if (r.inLoc && r.inAddress) known.set(key(r.inLoc), r.inAddress);
    if (r.outLoc && r.outAddress) known.set(key(r.outLoc), r.outAddress);
  }
  let lookups = 0;
  for (const r of rows) {
    for (const [loc, field, column] of [[r.inLoc, "inAddress", "in_address"], [r.outLoc, "outAddress", "out_address"]]) {
      if (!loc || r[field]) continue;
      let addr = known.get(key(loc));
      if (!addr) {
        if (lookups >= limit) continue;
        if (lookups > 0) await new Promise((done) => setTimeout(done, 1100));
        lookups++;
        addr = await reverseGeocode(loc.lat, loc.lng);
        if (!addr) continue;
        known.set(key(loc), addr);
      }
      r[field] = addr;
      await db.from("time_entries").update({ [column]: addr }).eq("id", r.id);
    }
  }
}

/* ---------- time zone + monthly history helpers ---------- */
export function safeTz(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Local date / time / weekday of an ISO timestamp in the user's time zone. */
export function parts(iso, tz) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true })
    .format(d)
    .replace(/[\u202f\u00a0]/g, " ");
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  return { date, time, weekday };
}

export const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || "");
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || "");

const loc = (lat, lng) => (typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null);

/**
 * Entries for one month (oldest first). Employees always get their own rows.
 * Managers can ask for one person (employee=<id>) or everyone (employee=all).
 */
export async function loadMonth(auth, { month, tz, employee }) {
  const isManager = auth.profile.role === "manager";
  let who = auth.user.id;
  if (isManager) {
    if (employee === "all") who = null;
    else if (isUuid(employee)) who = employee;
  }

  const [y, m] = month.split("-").map(Number);
  const pad = 864e5; // query one extra day each side, then filter by local date
  const from = new Date(Date.UTC(y, m - 1, 1) - pad).toISOString();
  const to = new Date(Date.UTC(y, m, 1) + pad).toISOString();

  let q = auth.db
    .from("time_entries")
    .select("id, employee_id, clock_in, clock_out, duration_minutes, note, out_note, in_photo, out_photo, in_lat, in_lng, out_lat, out_lng, in_address, out_address, profiles(name)")
    .gte("clock_in", from)
    .lt("clock_in", to)
    .order("clock_in", { ascending: true })
    .limit(5000);
  if (who) q = q.eq("employee_id", who);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = data
    .filter((e) => parts(e.clock_in, tz).date.startsWith(month))
    .map((e) => {
      const inP = parts(e.clock_in, tz);
      const outP = e.clock_out ? parts(e.clock_out, tz) : null;
      return {
        id: e.id,
        employeeId: e.employee_id,
        name: e.profiles?.name || "",
        date: inP.date,
        day: inP.weekday,
        inTime: inP.time,
        outTime: outP ? outP.time + (outP.date !== inP.date ? " (+1 day)" : "") : null,
        hours: e.clock_out ? Math.round((e.duration_minutes / 60) * 100) / 100 : null,
        remarks: [e.note, e.out_note].filter(Boolean).join(" / "),
        inPhoto: e.in_photo,
        outPhoto: e.out_photo,
        inLoc: loc(e.in_lat, e.in_lng),
        outLoc: loc(e.out_lat, e.out_lng),
        inAddress: e.in_address,
        outAddress: e.out_address,
      };
    });
  return { rows, everyone: who === null };
}
