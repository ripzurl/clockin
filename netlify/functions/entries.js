import { authenticate, isMonth, json, loadMonth, safeTz } from "./_lib.js";

export default async (req) => {
  const auth = await authenticate(req);
  if (!auth) return json({ error: "Please sign in again." }, 401);

  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  if (!isMonth(month)) return json({ error: "Choose a month." }, 400);
  const tz = safeTz(url.searchParams.get("tz") || "UTC");
  const isManager = auth.profile.role === "manager";

  let result;
  try {
    result = await loadMonth(auth, { month, tz, employee: url.searchParams.get("employee") });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
  const { rows } = result;

  // Private photos: short-lived signed links (1 hour) instead of public URLs.
  const paths = rows.flatMap((r) => [r.inPhoto, r.outPhoto]).filter(Boolean);
  const urlFor = {};
  if (paths.length) {
    const { data: signed } = await auth.db.storage.from("attendance-photos").createSignedUrls(paths, 3600);
    (signed || []).forEach((s) => {
      if (s.signedUrl && s.path) urlFor[s.path] = s.signedUrl;
    });
  }

  const entries = rows
    .map(({ inPhoto, outPhoto, ...r }) => ({
      ...r,
      inPhotoUrl: inPhoto ? urlFor[inPhoto] || null : null,
      outPhotoUrl: outPhoto ? urlFor[outPhoto] || null : null,
    }))
    .reverse(); // newest first on screen

  const totalHours = Math.round(rows.reduce((s, r) => s + (r.hours || 0), 0) * 100) / 100;
  const daysWorked = new Set(rows.map((r) => r.employeeId + r.date)).size;

  let people = [];
  if (isManager) {
    const { data } = await auth.db.from("profiles").select("id, name").order("name", { ascending: true });
    people = data || [];
  }

  return json({ entries, totals: { hours: totalHours, days: daysWorked }, people });
};

export const config = { path: "/api/entries" };
