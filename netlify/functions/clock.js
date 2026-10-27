import { authenticate, checkGeofence, json, num, photoMode, reverseGeocode } from "./_lib.js";

const BUCKET = "attendance-photos";
const MAX_PHOTO_BYTES = 1_500_000;

/** Accepts only a JPEG data URL and returns a Buffer, or null if it isn't a valid photo. */
function decodePhoto(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 1000 || buf.length > MAX_PHOTO_BYTES) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // JPEG signature
  return buf;
}

async function savePhoto(db, userId, action, buf) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${userId}/${stamp}-${action}.jpg`;
  const { error } = await db.storage
    .from(BUCKET)
    .upload(path, buf, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error("Could not save the photo: " + error.message);
  return path;
}

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
    if (action !== "in" && action !== "out") return json({ error: "Unknown action." }, 400);

    const lat = num(body.lat);
    const lng = num(body.lng);
    const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;

    const geo = checkGeofence(lat, lng);
    if (!geo.ok) return json({ error: geo.error }, 403);

    // Look up the street address while the photo is being checked and saved
    const addressPromise = reverseGeocode(lat, lng);

    // Photo rules
    const mode = photoMode();
    let photo = null;
    if (mode !== "off" && body.photo) {
      photo = decodePhoto(body.photo);
      if (!photo) return json({ error: "The photo could not be read. Please retake it." }, 400);
    }
    if (mode === "required" && !photo) {
      return json({ error: "A photo is required to clock in or out." }, 400);
    }

    let photoPath = null;
    if (photo) {
      try {
        photoPath = await savePhoto(db, user.id, action, photo);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    const discardPhoto = async () => {
      if (photoPath) await db.storage.from(BUCKET).remove([photoPath]);
    };

    const address = await addressPromise;

    // Server time is the source of truth, never the phone's clock.
    const now = new Date().toISOString();

    if (action === "in") {
      const { data, error } = await db
        .from("time_entries")
        .insert({
          employee_id: user.id,
          clock_in: now,
          in_lat: lat,
          in_lng: lng,
          in_photo: photoPath,
          in_address: address,
          note,
        })
        .select()
        .single();

      if (error) {
        await discardPhoto();
        // 23505 = unique violation: an open entry already exists
        if (error.code === "23505") return json({ error: "You are already clocked in." }, 409);
        return json({ error: error.message }, 500);
      }
      return json({ entry: data });
    }

    // action === "out"
    const { data, error } = await db
      .from("time_entries")
      .update({
        clock_out: now,
        out_lat: lat,
        out_lng: lng,
        out_address: address,
        ...(photoPath ? { out_photo: photoPath } : {}),
        out_note: note,
      })
      .eq("employee_id", user.id)
      .is("clock_out", null)
      .select()
      .maybeSingle();

    if (error) {
      await discardPhoto();
      return json({ error: error.message }, 500);
    }
    if (!data) {
      await discardPhoto();
      return json({ error: "You are not clocked in." }, 409);
    }
    return json({ entry: data });
  }

  return json({ error: "Method not allowed." }, 405);
};

export const config = { path: "/api/clock" };
