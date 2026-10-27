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

/** off = no camera step, optional = camera shown with a Skip button, required = photo mandatory */
export const photoMode = () =>
  ["off", "optional", "required"].includes(process.env.PHOTO_MODE) ? process.env.PHOTO_MODE : "optional";

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
    .select("id, employee_id, clock_in, clock_out, duration_minutes, note, out_note, in_photo, out_photo, profiles(name)")
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
      };
    });
  return { rows, everyone: who === null };
}
