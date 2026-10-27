import { authenticate, json } from "./_lib.js";

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Neutralise spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default async (req) => {
  const auth = await authenticate(req);
  if (!auth) return json({ error: "Please sign in again." }, 401);
  if (auth.profile.role !== "manager") return json({ error: "Managers only." }, 403);

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let q = auth.db
    .from("time_entries")
    .select("id, employee_id, clock_in, clock_out, duration_minutes, note, profiles(name)")
    .order("clock_in", { ascending: false })
    .limit(2000);
  if (from) q = q.gte("clock_in", from);
  if (to) q = q.lt("clock_in", to);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const rows = data.map((e) => ({
    id: e.id,
    name: e.profiles?.name || "",
    clock_in: e.clock_in,
    clock_out: e.clock_out,
    duration_minutes: e.duration_minutes,
    note: e.note,
  }));

  if (url.searchParams.get("format") === "csv") {
    const header = ["Employee", "Clock in (UTC)", "Clock out (UTC)", "Minutes", "Note"];
    const lines = rows.map((r) =>
      [r.name, r.clock_in, r.clock_out, r.duration_minutes, r.note].map(csvCell).join(",")
    );
    return new Response([header.join(","), ...lines].join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="time-entries.csv"',
        "Cache-Control": "no-store",
      },
    });
  }

  return json({ entries: rows });
};

export const config = { path: "/api/entries" };
