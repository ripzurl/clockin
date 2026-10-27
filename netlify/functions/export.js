import ExcelJS from "exceljs";
import { authenticate, isMonth, json, loadMonth, safeTz } from "./_lib.js";

const NAVY = "FF163A70";

export default async (req) => {
  const auth = await authenticate(req);
  if (!auth) return json({ error: "Please sign in again." }, 401);

  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  if (!isMonth(month)) return json({ error: "Choose a month." }, 400);
  const tz = safeTz(url.searchParams.get("tz") || "UTC");

  let result;
  try {
    result = await loadMonth(auth, { month, tz, employee: url.searchParams.get("employee") });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
  const { rows, everyone } = result;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Time Clock";
  wb.created = new Date();

  const ws = wb.addWorksheet("Attendance", { views: [{ state: "frozen", ySplit: 1 }] });
  const cols = [{ header: "Date", key: "date", width: 13 }, { header: "Day", key: "day", width: 7 }];
  if (everyone) cols.push({ header: "Employee", key: "name", width: 24 });
  cols.push(
    { header: "Clock IN", key: "inTime", width: 13 },
    { header: "Clock OUT", key: "outTime", width: 17 },
    { header: "Hours", key: "hours", width: 9 },
    { header: "Clock IN location", key: "inLoc", width: 26 },
    { header: "Clock OUT location", key: "outLoc", width: 26 },
    { header: "Remarks", key: "remarks", width: 40 }
  );
  ws.columns = cols;

  // Location cell: "lat, lng" that opens Google Maps when clicked
  const mapCell = (l) =>
    l ? { text: `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`, hyperlink: `https://www.google.com/maps?q=${l.lat},${l.lng}` } : "";

  rows.forEach((r) =>
    ws.addRow({
      date: r.date,
      day: r.day,
      name: r.name,
      inTime: r.inTime,
      outTime: r.outTime || "Still clocked in",
      hours: r.hours,
      inLoc: mapCell(r.inLoc),
      outLoc: mapCell(r.outLoc),
      remarks: r.remarks,
    })
  );
  ["inLoc", "outLoc"].forEach((k) =>
    ws.getColumn(k).eachCell((c, n) => {
      if (n > 1 && c.value && c.value.hyperlink) c.font = { color: { argb: "FF1155CC" }, underline: true };
    })
  );

  const hoursCol = ws.getColumn("hours");
  hoursCol.numFmt = "0.00";
  const hoursLetter = hoursCol.letter;
  const lastRow = rows.length + 1;
  const total = ws.addRow({ date: "Total" });
  total.getCell("hours").value = {
    formula: `SUM(${hoursLetter}2:${hoursLetter}${Math.max(lastRow, 2)})`,
    result: Math.round(rows.reduce((s, r) => s + (r.hours || 0), 0) * 100) / 100,
  };
  total.font = { bold: true };

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  header.alignment = { vertical: "middle" };
  header.height = 22;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  ["inTime", "outTime", "hours"].forEach((k) => (ws.getColumn(k).alignment = { horizontal: "right" }));
  header.getCell("inTime").alignment = { horizontal: "right" };
  header.getCell("outTime").alignment = { horizontal: "right" };
  header.getCell("hours").alignment = { horizontal: "right" };

  // Everyone: add a per-person summary sheet
  if (everyone) {
    const sum = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
    sum.columns = [
      { header: "Employee", key: "name", width: 26 },
      { header: "Days worked", key: "days", width: 14 },
      { header: "Total hours", key: "hours", width: 14 },
    ];
    const by = new Map();
    rows.forEach((r) => {
      const e = by.get(r.employeeId) || { name: r.name, dates: new Set(), hours: 0 };
      e.dates.add(r.date);
      e.hours += r.hours || 0;
      by.set(r.employeeId, e);
    });
    [...by.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((e) => sum.addRow({ name: e.name, days: e.dates.size, hours: Math.round(e.hours * 100) / 100 }));
    sum.getColumn("hours").numFmt = "0.00";
    const sh = sum.getRow(1);
    sh.font = { bold: true, color: { argb: "FFFFFFFF" } };
    sh.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  }

  const who = everyone ? "All-staff" : (rows[0]?.name || auth.profile.name || "Me");
  const safe = String(who).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "Me";
  const buf = await wb.xlsx.writeBuffer();

  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Attendance-${month}-${safe}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
};

export const config = { path: "/api/export" };
