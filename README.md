# Time Clock: Netlify + Supabase

Mobile-friendly clock-in / clock-out app. Installable as a PWA, works inside a Microsoft Teams tab.

```
public/                 front end (static, no build step)
netlify/functions/      /api/config, /api/clock, /api/entries
supabase/schema.sql     tables, constraints, row level security
```

## Setup (about 15 minutes)

### 1. Supabase
1. Create a project at supabase.com.
2. SQL Editor > New query > paste `supabase/schema.sql` > Run.
3. Authentication > Providers > Email is on by default. For a quick test, you can turn off
   "Confirm email" so new accounts can sign in immediately.
4. Project Settings > API: copy the Project URL, the anon (publishable) key,
   and the service_role (secret) key.

### 2. Run locally (optional)
```bash
npm install
cp .env.example .env      # fill in the values
npx netlify dev           # http://localhost:8888
```

### 3. Deploy to Netlify
1. Push this folder to GitHub, then Netlify > Add new site > Import from Git.
   (Or run `npx netlify deploy --prod`.) Build command: leave empty. Publish directory: `public`.
2. Site settings > Environment variables, add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`  (mark as secret)
   - `GEOFENCE_ENABLED`, `WORK_LAT`, `WORK_LNG`, `WORK_RADIUS_METERS`  (optional)
3. Redeploy so the functions pick up the variables.

### 4. Create your first manager
Sign up in the app, then run this in the Supabase SQL Editor:
```sql
update public.profiles set role = 'manager'
where id = (select id from auth.users where email = 'you@example.com');
```
A "Team" tab appears with all entries, a date filter, and CSV export.

### 5. (Optional) Open it in Microsoft Teams
Add the Netlify URL as a custom tab or build a Teams app package pointing at it.
Note: Supabase email/password sign-in works inside a tab. For single sign-on with
Microsoft accounts, enable the Azure provider in Supabase Auth.

## How it protects the data
- The browser only talks to `/api/*`. It never writes to the database directly.
- Functions verify the Supabase token on every call.
- Timestamps come from the server clock, not the phone.
- A unique partial index guarantees one open shift per employee, even with double taps.
- The geofence is checked on the server (set `GEOFENCE_ENABLED=true`).
- The service role key lives only in Netlify environment variables.
- Row level security lets employees read only their own rows.

## Ideas for next steps
- Manager edits/corrections with an audit table
- Break tracking (add `type` column or a `breaks` table)
- QR code check-in at the workplace as a second factor against GPS spoofing
- Offline queue: store the punch in IndexedDB and sync (server time would then need a "recorded at" field)
- Reminder emails with Netlify scheduled functions
- Location/photo consent screen and a data-retention policy (important in many countries)
