# NeoSeat — Real-Time Seat Booking & Ticketing Platform

NeoSeat is a premium, real-time ticket booking platform designed to handle high concurrency, prevent double-bookings, and automate waitlist promotions using Node.js, Express, TypeScript, PostgreSQL, Redis, Socket.IO, and React.

## Live Demo

- **Frontend:** [seat-booking-system-mauve.vercel.app](https://seat-booking-system-mauve.vercel.app)
- **Backend API:** [seat-booking-system-ahns.onrender.com](https://seat-booking-system-ahns.onrender.com)

> The backend runs on a free-tier instance and may take 30–90 seconds to wake up if it's been inactive. Please be patient on the first request.

## Screenshots

![Homepage](docs/screenshots/homepage.png)
![Seat Selection Grid](docs/screenshots/seat-grid.png)
![Booking Confirmation](docs/screenshots/confirmation.png)

## Live Production Deployment

The application is deployed and live in production:
*   **Web Frontend (Vercel):** `https://[YOUR-VERCEL-SUBDOMAIN].vercel.app` *(Replace this with your actual Vercel URL)*
*   **Backend API (Render):** `https://seat-booking-system-ahns.onrender.com`
*   **Database (Neon PostgreSQL):** Managed serverless PostgreSQL
*   **Cache & Locks (Upstash Redis):** Managed Redis instance with Key Expiry notifications enabled

### Website Preview
*(To add a screenshot of your website here, take a screenshot of your web browser, name it `screenshot.png`, save it in this root folder, and commit it to GitHub. It will display below!)*

![NeoSeat Live Dashboard](screenshot.png)

---

## Architecture Overview

```
                 +-----------------------+
                 |  Vite React Frontend  |
                 +-----------+-----------+
                             |  HTTP & WebSockets
                             v
                 +-----------+-----------+
                 |  Node Express Backend  |
                 +-----+-----------+-----+
                       |           |
        Queries / Txns |           | Commands / Locks / Expirations
                       v           v
                 +-----+----+ +----+-----+
                 | Postgres | |  Redis   |
                 +----------+ +----------+
```

## ⚙️ Core Concurrency Mechanisms

### 1. Real-time Seat Hold & Concurrency Control

When a user clicks on an available seat:

- The backend issues a Redis atomic command: `SET seat:<eventId>:<seatId> hold:<userId> NX EX 600`
- **Success** (NX condition met): the seat is locked for 10 minutes. A Socket.IO event `seat_update` is broadcast immediately: `{ eventId, seatId, status: 'held', userId }`
- **Failure** (NX condition not met): if the seat is already held or booked, the atomic operation fails and the backend returns a `409 Conflict`

If the 10 minutes expire without checkout:
- Redis fires an `expired` event
- The subscriber thread receives it, queries the DB to check if it was a waitlist offer, and if not, broadcasts the seat as available to all users via Socket.IO

### 2. Waitlist Promotion & Cancellation Engine

When a sold-out category has a cancellation:

1. The cancelled booking is set to `cancelled` inside a PostgreSQL transaction
2. The backend queries the database for the oldest waitlist entry with status `waiting` for that event and category:
   ```sql
   SELECT * FROM waitlist WHERE status = 'waiting' ORDER BY created_at ASC LIMIT 1 FOR UPDATE
   ```
3. **If a waitlist member is found:**
   - The entry is updated to `offered`, locking in the specific `offered_seat_id`
   - A Redis lock is set for 15 minutes: `SET seat:<eventId>:<seatId> offer:<waitlistId>:<userId> NX EX 900`
   - A JWT token containing the promotion metadata is generated
   - The user is emailed a signed link containing this token
   - The seat is shown as `offered` on the seat map
4. **If the offer expires (TTL hits 0):**
   - Redis fires an expiry event for `seat:<eventId>:<seatId>`
   - The keyspace event listener catches it, finds the matching `offered` waitlist entry in the DB, and marks it as `expired`
   - The system triggers the promotion flow again for the same seat, passing it to the next person in line

## 📁 Project Structure

```
seat-booking-system/
├── docker-compose.yml           # Runs local Postgres and Redis
├── README.md                    # Project documentation
├── system_design.md             # Concurrency & design writeup
├── backend/                     # Node.js + Express + TypeScript service
│   ├── src/
│   │   ├── index.ts             # Express & Socket.IO server startup
│   │   ├── config/              # DB, Redis, and env configuration
│   │   ├── middleware/          # JWT check & role-based authentication
│   │   ├── routes/               # Auth, Venues, Events, Seats, Bookings
│   │   ├── services/            # Mail, Socket emitter, Waitlist promotion
│   │   └── db/                  # SQL schema definitions & seeding scripts
│   ├── package.json
│   └── tsconfig.json
└── frontend/                    # Vite + React + TypeScript web app
    ├── src/
    │   ├── main.tsx              # DOM mount & Context wrapper
    │   ├── App.tsx                # Main dashboard container & live updates
    │   ├── index.css              # Custom vanilla CSS premium design system
    │   └── context/               # AuthContext session provider
    ├── package.json
    └── vite.config.ts
```

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript |
| Backend | Node.js + Express + TypeScript + Socket.IO |
| Database | PostgreSQL |
| Cache / Real-time locks | Redis (keyspace notifications for seat holds & waitlist) |
| Auth | JWT |
| Hosting | Vercel (frontend), Render (backend), Neon (Postgres), Upstash (Redis) |

## 🚀 Local Setup Instructions

### Prerequisites
- Node.js (v20+ or v24+)
- Docker Desktop active on your local machine

### Step 1: Start Databases

From the root directory, run:
```bash
docker compose up -d
```
This boots up PostgreSQL on `localhost:5432` and Redis on `localhost:6379`. Redis is automatically configured with keyspace notifications enabled (`--notify-keyspace-events KEx`).

### Step 2: Configure and Run Backend

Open the `/backend` folder. The `.env` file is pre-configured with local default values:

```env
PORT=5000
NODE_ENV=development
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ticket_db
REDIS_URL=redis://localhost:6379
JWT_SECRET=supersecretjwtkey12345!
JWT_EXPIRES_IN=24h
FRONTEND_URL=http://localhost:5173

# Leave email configs blank to auto-generate Ethereal credentials on startup
EMAIL_HOST=smtp.ethereal.email
EMAIL_PORT=587
EMAIL_USER=
EMAIL_PASS=
```

Run install and start the dev server:
```bash
npm install
npm run dev
```

> **Note:** On startup, the database schema applies automatically and seeds three default accounts with the password `password123`:
> - **Admin:** admin@ticket.com
> - **Organiser:** organiser@ticket.com
> - **Customer:** customer@ticket.com
>
> Also check console logs for the Ethereal email test credentials and email preview URLs.

### Step 3: Configure and Run Frontend

Open the `/frontend` folder:
```bash
npm install --legacy-peer-deps
npm run dev
```
Open `http://localhost:5173` in your browser.

## 📡 API Documentation

### 1. Authentication Routes
- `POST /api/auth/register` — Create user account. Body: `{ email, password, role }`
- `POST /api/auth/login` — Sign in user. Body: `{ email, password }`

### 2. Venue Management (Admin Only)
- `POST /api/venues` — Create a venue and auto-populate grid coordinate seats. Body: `{ name, rowsCount, colsCount, rowCategories }`
  - Example `rowCategories`: `{ A: 'VIP', B: 'Premium', default: 'Standard' }`
- `GET /api/venues` — Fetch all venues

### 3. Event Management (Organiser / Admin Only)
- `POST /api/events` — Publish an event linked to a venue with pricing per seat category. Body: `{ name, venueId, eventDate, eventTime, pricing }`
- `GET /api/events` — Fetch all events with pricing details
- `GET /api/events/:id` — Fetch detailed details of a specific event

### 4. Seat Holds & Map Status
- `GET /api/seats/layout?eventId=xxx` — Returns venue seats grid with real-time status (`available`, `held`, `offered`, `booked`) and client details
- `POST /api/seats/hold` — Acquire a 10-minute Redis lock on a seat. Body: `{ eventId, seatId }`
- `POST /api/seats/release` — Manually release a held seat. Body: `{ eventId, seatId }`
- `POST /api/seats/waitlist` — Join waitlist for sold-out categories. Body: `{ eventId, category }`
- `POST /api/seats/waitlist/confirm` — Claim a waitlist offer using a signed email JWT token. Body: `{ token }`

### 5. Bookings
- `POST /api/bookings/checkout` — Convert a Redis held seat into a permanent PostgreSQL booking row. Body: `{ eventId, seatId }`
- `POST /api/bookings/cancel/:id` — Cancel booking and trigger waitlist promotion
- `GET /api/bookings/my-bookings` — Fetch customer booking history
- `GET /api/bookings/revenue` — Grouped SQL query displaying sold tickets count and total revenue per event (Organiser/Admin only)

## 📄 License

This project was built as part of a technical assignment submission.
