# East Gate

Enterprise real estate, construction materials, and specialist services platform for Nigeria.

## Project Structure

- Frontend: Static HTML/CSS/JS in root (`index.html`, `admin.html`, `dashboard.html`, `marketplace.html`, etc.)
- Backend: Express + TypeScript + Prisma ORM in `server/`
- Auth: `server/auth.ts` (password hashing, session tokens, route guards), `js/auth.js` (session client)
- Database: PostgreSQL (schema in `prisma/schema.prisma`, seed in `prisma/seed.ts`)
- Data layer: Frontend falls back to localStorage (`js/store.js`) if API unavailable

## Prerequisites

- Node.js 18+
- PostgreSQL database running
- Environment variables configured

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and configure the variables:
   ```bash
   cp .env.example .env
   ```
   - `DATABASE_URL` — PostgreSQL connection string
   - `PORT` — API server port (default `3000`)
   - `SESSION_SECRET` — signs session tokens; minimum 32 characters. Generate with:
     ```bash
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```

3. Generate Prisma client:
   ```bash
   npm run db:generate
   ```

4. Set up database schema:
   ```bash
   npm run db:push
   ```

5. Seed the database:
   ```bash
   npm run db:seed
   ```

## Development

Run the API server with hot reload:
```bash
npm run dev
```

The server serves static files from project root and runs on `http://localhost:3000` by default.

## Production

Build and start:
```bash
npm run build
npm start
```

## Authentication

Sign-in is handled by the API server. Passwords are hashed with `scrypt`
(`server/auth.ts`) — no native modules required.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Exchange email + password for a signed session token |
| `GET` | `/api/auth/me` | Validate the token and return the live account |
| `POST` | `/api/auth/logout` | Record sign-out in the audit trail |
| `POST` | `/api/auth/validate` | Token check used by the frontend route guard |
| `POST` | `/api/auth/register` | **Public** member sign-up; creates an active `CUSTOMER` account |
| `POST` | `/api/dealer/register` | **Public** dealer sign-up; creates an `UNDER_REVIEW` account |
| `GET` | `/api/listing-types` | The purpose vocabulary, served from the `ListingType` enum |
| `POST` | `/api/dealer/properties` | Dealer submits a listing; `listingType` is validated against the enum |
| `POST` | `/api/dealer/services` | Dealer submits a service offering (`PENDING_REVIEW`) |
| `GET` | `/api/dealer/services/list` | The signed-in dealer's own service submissions |
| `GET` | `/api/admin/queue` | Pending properties, products, services, dealers + verified-dealer count |
| `GET` | `/api/admin/reports` | Moderation queue with resolved target titles |
| `GET` | `/api/admin/audit-logs` | The immutable audit trail |
| `POST` | `/api/admin/approve` | Publish a pending item (`entityType`: property/product/service) |
| `POST` | `/api/admin/reject` | Reject a pending item with a reason |
| `POST` | `/api/admin/verify-dealer` | Verify a dealer by `dealerId` and award the Verified badge; clears every credential they have on file |

Tokens are HMAC-SHA256 signed and expire after 12 hours, or 30 days when
"Remember me" is used. The frontend keeps them in `sessionStorage`
(`localStorage` when remembered) and sends them as `Authorization: Bearer`.

Protected routes use `requireAuth` / `requireRole`:

- `/api/inspections`, `/api/user/inspections/:userId` — any signed-in user
- `/api/dealer/*` — `DEALER` or `ADMIN`
- `/api/admin/*` — `ADMIN` (and `SUPER_ADMIN`)

`dashboard.html`, `dealer-dashboard.html` and `admin.html` call
`EastGateAuth.guardPage()` and bounce unauthenticated visitors to
`login.html?next=…`. Failed sign-ins are rate-limited to 8 attempts per IP
every 15 minutes and written to the audit trail.

Two fragments on `dealer-dashboard.html` are meaningful:

- `#register` — the **public** dealer sign-up pane. It hides the dashboard
  entirely, so a signed-out visitor receives no protected markup.
- `#add`, `#products`, `#services`, `#listings`, `#verification` — open the
  matching dashboard tab.

### Two kinds of registration

| | Endpoint | Page | Review gate |
|---|---|---|---|
| **Member** | `POST /api/auth/register` | `register.html` | None — usable immediately |
| **Dealer** | `POST /api/dealer/register` | `dealer-dashboard.html#register` | `UNDER_REVIEW`, admin must verify |

Member sign-up asks for name, email, phone and a password, and the role is
always forced to `CUSTOMER` — a `role` field in the request body is ignored.
Email is lower-cased before the uniqueness check, so `A@B.com` and `a@b.com`
cannot both register. On success the page signs the new member in and lands
them on `dashboard.html`; if that auto-login ever fails it falls back to
`login.html?next=dashboard.html` rather than stranding them.

Dealer sign-up also captures business name, CAC number, category and location.
It is deliberately public (it is how new dealers get an account). It validates
every field, enforces unique email/phone/CAC, rate-limits per IP, hashes the
password with scrypt, and creates the account as `UNDER_REVIEW` with
`role = DEALER`. Nothing a dealer submits is publicly visible until an admin
approves it — `GET /api/dealers` filters to `VERIFIED` profiles for exactly
this reason. There is no email verification step yet on either flow — worth
adding before production.

Both screens share `css/auth.css`, so the sign-in and sign-up pages cannot
drift apart visually.

> **Known trade-off:** both endpoints answer `409` with a specific
> "that email address is already registered" message. That is good UX but it
> does let an unauthenticated visitor probe which addresses have accounts.
> Returning a generic success would close the enumeration hole at the cost of a
> confusing sign-up flow. Worth revisiting if the platform goes public.

### Admin console

`admin.html` reads live data from `GET /api/admin/queue`,`/api/admin/reports` and `/api/admin/audit-logs`, and falls back to the
`EastGateDB` mock store only when the server is unreachable. Approve, reject
and verify all call the API and re-fetch afterwards.

The **Dealer Verification Workbench** decides about *dealers*, not files: the
queue's `pendingDealers` are `DealerProfile` rows at `UNDER_REVIEW` (a fresh
sign-up arrives with no documents at all), with each dealer's credential files
folded underneath them. In this sense `verifications` is now a secondary list —
only documents lodged against a dealer who is not themselves pending stay there.
`POST /api/admin/verify-dealer` takes a `dealerId` and clears every outstanding
credential for that agency in one call (a `docId` is still resolved for older
callers); the Title Documents badge is only awarded when a title/survey file is
actually on record.

Because the queue now renders text that came in through the public
registration form, every value is HTML-escaped and URLs are scheme-checked
(`http`/`https` only) before being interpolated into `innerHTML`.

### Listing purpose

`Property.listingType` records **why a property is being offered**, and is
deliberately a different axis from `Property.category`, which records **what the
property is**. A plot of land can be `BUY` (outright purchase) or `LAND_BANKING`
(held for appreciation); an office can be `BUY` or `COMMERCIAL_LEASE`.

| Value | Shown as |
| --- | --- |
| `BUY` | Buy (Outright Purchase) |
| `SHORT_LET` | Rent (Short Let) |
| `LONG_LET` | Rent (Long Let) |
| `LONG_LEASE` | Long Lease |
| `COMMERCIAL_LEASE` | Commercial Lease |
| `INDUSTRIAL_LEASE` | Industrial Lease |
| `LAND_BANKING` | Land Banking & Investment |
| `DISTRESS_SALE` | Sale (Distress / Auction) |
| `JOINT_VENTURE` | Joint Venture / Development |
| `STAFF_QUARTERS` | Student / Staff Quarters |

The enum in `prisma/schema.prisma` is the source of truth for the **values**.
The labels live in `LISTING_TYPE_LABELS` in `server/index.ts` and are served by
`GET /api/listing-types`, which is what `properties.html` uses to build its
dropdown.

> **Four copies of the label list must stay in step:**
> `LISTING_TYPE_LABELS` (`server/index.ts`), the static `<option>` fallback in
> `index.html`, the static `<option>` fallback in `properties.html`, and
> `LISTING_TYPE_LABELS` in `admin.html`. Only the first is authoritative. The
> TypeScript side is protected — it is typed `Record<ListingType, string>`, so
> adding an enum member without a label fails `tsc`. **The HTML copies are not
> checked by anything** and will silently go stale.

`GET /api/properties` accepts `?listingType=`, `?category=` and `?state=`, with
`ALL` as the "no filter" sentinel. Both enum params are validated by
`parseEnumValue()` before they reach Prisma, so a bad value is a `400` with a
readable message rather than the `500` that Postgres raises on an unknown enum
label. The parser folds case and treats spaces and hyphens as underscores, so
`?listingType=short-let` resolves.

> **Note:** `RENT`, `LEASE` and `LAND` were removed from the enum — they were
> either unused or ambiguous (`LEASE` had no rows and no UI). `prisma/seed.ts`
> and `dealer-dashboard.html` were updated in the same change. Run
> `npm run db:push` against a database whose rows you no longer need, or
> `prisma db push --force-reset` followed by `npm run db:seed`, because dropping
> enum values cannot run inside the transaction Prisma uses.

On `index.html` the **Buy / Rent / Land** tabs narrow the Purpose dropdown to the
purposes that belong to that axis (`initDynamicSearch()` in `js/main.js`), and
Search hands the choice to `properties.html?purpose=…`, which preselects the
filter. A `?purpose=` value the dropdown does not offer is ignored rather than
silently emptying the results.

> **Known gap:** the public catalogue still reads from the localStorage mock
> store (`properties.html` → `EastGateDB`) rather than from `GET /api/properties`.
> `EastGateAPI.getProperties()` exists, applies all three filters in its
> localStorage fallback, and is correct — but nothing calls it yet. Until a page
> does, the purpose filter works only against mock data, and the DB rows are
> invisible on the public site. This is the next thing worth doing.

### The admin entry point

The admin console is an **unlisted URL**. No page in the public UI links to it.

`admin.html` is reachable only by typing the path directly. `initAdminBadge()`
in `js/main.js` still injects a discreet **Admin** badge into the bottom-left
corner (styled by `.admin-badge` in `css/portals.css`, opposite the floating
WhatsApp button so the two never collide), but it renders for exactly one
audience:

| Visitor | Badge |
| --- | --- |
| Signed in as an admin | shown, links straight to `admin.html`, with a green status dot |
| Signed out | not rendered — nothing points at the admin sign-in |
| Signed in, anyone else | not rendered |

Previously signed-out visitors were also given a badge linking to
`login.html?next=admin.html`, which made every public page a lit signpost to the
most privileged account on the platform. That branch is gone.

This is obscurity, not access control. `admin.html` remains role-guarded by the
server (`requireRole`), and an admin who is signed in still gets the badge as a
convenience. Removing the link raises the cost of *finding* the console; it does
not weaken anything, because the guard was always the thing doing the work.

Signing in with the super-admin credentials redirects straight to
`admin.html`, because `landingPageFor()` maps both `ADMIN` and `SUPER_ADMIN` to
that page. The `next` parameter is validated against
`^[a-z0-9._-]+\.html(\?[^#]*)?(#[a-z0-9_-]+)?$` before it is used, so it can
only ever point at a local page — no open redirect via `?next=`.

> **Before production:** the admin entry point is no longer advertised, but the
> super-admin password is still defined in `prisma/seed.ts` — that is where the
> account is created, so it has to live somewhere. It has been removed from this
> README and from the sign-in demo panel, but anyone with read access to the
> repository still has it. It is also only eight characters long. Rotate it, add
> email verification, and move the seeded credential into an environment variable
> before this faces real users. See
> [Demo credentials](#demo-credentials) below.

### Testing note

`node_modules/.bin` may be empty in some checkouts. Invoke tools directly:

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/tsx/dist/cli.mjs prisma/seed.ts
node node_modules/tsx/dist/cli.mjs server/index.ts
node node_modules/prisma/build/index.js db push --skip-generate
```

`tsconfig.json` only includes `server/**/*` — its `rootDir` is `./server`, so
`prisma/` cannot be added there without breaking the `dist/` layout. That means
**`prisma/seed.ts` is not typechecked** and a stale enum reference in it surfaces
at runtime rather than at build time. `tsconfig.check.json` covers both:

```bash
node node_modules/typescript/bin/tsc --project tsconfig.check.json
```

### Demo accounts

Created by `npm run db:seed`:

| Role | Email | Password |
| --- | --- | --- |
| Customer | `jay@example.com` | `EastGate@Jay2026` |
| Dealer (verified) | `dealer@johnproperties.ng` | `EastGate@John2026` |
| Dealer (under review) | `apex@apexbuilders.ng` | `EastGate@Apex2026` |
| Super admin | `admin@eastgate.com` | *(not listed here — see below)* |

The three non-admin passwords are also one-click shortcuts in the **Demo
access** dropdown on `login.html`, so they are deliberately public and safe to
demonstrate with.

The **super-admin password is not listed in this README**. It is defined in
`prisma/seed.ts`, which is where the account is actually created — read it from
there. It was removed from the demo panel for the same reason it is absent here:
a one-click button to the most privileged account on the platform is not
something to hand to a visitor.

> Moving it out of `seed.ts` entirely means reading it from an environment
> variable (e.g. `ADMIN_SEED_PASSWORD`) so it never enters version control.
> That is a small change to `prisma/seed.ts` and is the right next step before
> this is deployed anywhere.

## Features

- Public listings filtered to APPROVED items only
- Dealer submissions require admin approval (PENDING_REVIEW)
- Admin control panel for approvals, rejections, verification, and audit logging
- 4-dimensional verification badges for dealers
- Inspection booking system
- Listing-purpose filtering (buy / short let / long let / lease / land banking /
  distress sale / joint venture) across the catalogue and the moderation queue
