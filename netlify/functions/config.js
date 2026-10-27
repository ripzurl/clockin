import { json } from "./_lib.js";

// Public values only. The anon key is safe to expose; row level security protects data.
export default async () =>
  json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    geofence: process.env.GEOFENCE_ENABLED === "true",
  });

export const config = { path: "/api/config" };
