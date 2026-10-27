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
