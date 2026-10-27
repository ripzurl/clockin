import { authenticate, checkGeofence, json, num } from "./_lib.js";

export default async (req) => {
  const auth = await authenticate(req);
  if (!auth) return json({ error: "Please sign in again." }, 401);
  const { db, user, profile } = auth;

  // GET: current status + recent entries
  if (req.method === "GET") {
    const { data, error } = await db
      .from("time_entries")
      .select("id, clock_in, clock_out, duration_minutes, note")
      .eq("employee_id", user.id)
      .order("clock_in", { ascending: false })
      .limit(10);
    if (error) return json({ error: error.message }, 500);

    const open = data.find((e) => !e.clock_out) || null;
    return json({
      profile,
      open,
      recent: data,
      serverTime: new Date().toISOString(),
    });
  }

  // POST: clock in / clock out
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid request." }, 400);
    }
    const { action } = body;
    const lat = num(body.lat);
    const lng = num(body.lng);
    const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;

    const geo = checkGeofence(lat, lng);
    if (!geo.ok) return json({ error: geo.error }, 403);

    // Server time is the source of truth, never the phone's clock.
    const now = new Date().toISOString();

    if (action === "in") {
      const { data, error } = await db
        .from("time_entries")
        .insert({ employee_id: user.id, clock_in: now, in_lat: lat, in_lng: lng, note })
        .select()
        .single();

      if (error) {
        // 23505 = unique violation: an open entry already exists
        if (error.code === "23505") return json({ error: "You are already clocked in." }, 409);
        return json({ error: error.message }, 500);
      }
      return json({ entry: data });
    }

    if (action === "out") {
      const { data, error } = await db
        .from("time_entries")
        .update({ clock_out: now, out_lat: lat, out_lng: lng, ...(note ? { note } : {}) })
        .eq("employee_id", user.id)
        .is("clock_out", null)
        .select()
        .maybeSingle();

      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "You are not clocked in." }, 409);
      return json({ entry: data });
    }

    return json({ error: "Unknown action." }, 400);
  }

  return json({ error: "Method not allowed." }, 405);
};

export const config = { path: "/api/clock" };
