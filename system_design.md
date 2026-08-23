# System Design & Concurrency Architecture - Ticketing Platform

This document outlines the detailed system design, concurrency controls, database schemas, and scalability strategies of the NeoSeat ticket booking system.

---

## 1. Concurrency Controls & Race Conditions Prevention

In a ticketing system under high demand (e.g., ticket drops for major concerts), thousands of concurrent users attempt to select and book the same set of high-value seats. Designing for this workload requires preventing double-booking and seat hogging while maintaining a responsive user experience.

### Atomic Seat Holds (Redis Lock)
To prevent race conditions, the application separates the ephemeral "seat reservation/hold" phase from the permanent "purchase/checkout" phase. When a user clicks a seat, the application attempts to acquire an atomic distributed lock on that seat in Redis using the command:

`SET seat:<eventId>:<seatId> hold:<userId> NX EX 600`

- **`NX` (Not Exists)**: Instructs Redis to set the key *only* if it does not already exist. Because Redis operations are single-threaded and atomic, this guarantees that only one request can successfully create the key, even if hundreds of requests arrive at the exact same millisecond.
- **`EX 600` (Expiry in Seconds)**: Sets a Time-To-Live (TTL) of 10 minutes (600 seconds) on the lock. This prevents "dead locks" where a user holds a seat but closes their browser, leaves the checkout flow, or loses connectivity. The system automatically releases the seat when the key expires.
- **`hold:<userId>` Value**: The value of the key stores the holding user's ID. When the user proceeds to checkout, the backend verifies that the key exists and that its value matches the user's ID (`hold:${userId}`). This prevents session hijacking, ensuring User A cannot checkout a seat that is currently held by User B.

### Postgres Transactions & Double-Booking Prevention
When a user clicks "Checkout", the backend transitions the hold from Redis into a permanent row in the `bookings` table. This transition is wrapped in an ACID-compliant PostgreSQL transaction:

```sql
BEGIN;
-- Lock the seat row for updates to prevent concurrent transaction interference
SELECT * FROM bookings WHERE event_id = $1 AND seat_id = $2 AND status = 'booked' FOR UPDATE;
-- Insert the booking row
INSERT INTO bookings (event_id, seat_id, user_id, booking_reference, price_paid, status) VALUES (...);
COMMIT;
```

Using `FOR UPDATE` on Postgres ensures that even if a Redis key is somehow bypassed or deleted, the database constraint and row-level lock act as a secondary guard. If a booking already exists, the database transaction aborts and rolls back. Once the transaction commits, the Redis key is deleted, and the seat is permanently marked as booked on the seat map.

---

## 2. Event-Driven Waitlist Promotion State Machine

When a seat category is sold out, users can join the waitlist. If a booked seat is cancelled, the system promotes the oldest waitlisted user.

```
       +--------------+
       |   Waiting    |
       +------+-------+
              |
              | Booking Cancelled
              v
       +--------------+
       |   Offered    | <----+ (Set Redis key seat:evt:seat = offer:wl:usr EX 900)
       +---+------+---+
           |      |
  15m Exp  |      | User Confirms
  (Redis)  |      | (JWT Token)
           v      v
     +-----+--+ +-+------+
     |Expired | | Booked | (Inserts into bookings)
     +-----+--+ +--------+
           |
           +---> (Cascades: Pop next 'Waiting' user)
```

The waitlist promotion engine operates as a state machine with four statuses: `waiting`, `offered`, `expired`, and `booked`.

1. **Waitlist Insertion**: If no seats are free in a category, a user joins the waitlist table with status `waiting`.
2. **Cancellation & Promotion**:
   When a user cancels a booking:
   - The booking's status is set to `cancelled`.
   - The backend pops the oldest waitlist entry with status `waiting` for that event and category:
     `SELECT * FROM waitlist WHERE event_id = $1 AND category = $2 AND status = 'waiting' ORDER BY created_at ASC LIMIT 1 FOR UPDATE`
   - If found, the entry status is updated to `offered`, and the `offered_seat_id` and `offered_at` columns are set.
   - The seat is locked in Redis for **15 minutes**:
     `SET seat:<eventId>:<seatId> offer:<waitlistId>:<userId> NX EX 900`
   - The user receives an email containing a link with a signed JWT token containing `{ waitlistId, userId, seatId, eventId }`.
   - The seat status is broadcasted as `offered` to all users via Socket.IO.
3. **Offer Expiration (Redis Keyspace Notifications)**:
   We configure Redis to publish events when keys expire: `notify-keyspace-events KEx`.
   - A dedicated Redis client subscribes to the channel `__keyevent@0__:expired`.
   - When the key `seat:<eventId>:<seatId>` expires, the subscriber parses the key.
   - It queries the database for any active waitlist entry in status `offered` for that seat and event:
     `SELECT id, category FROM waitlist WHERE event_id = $1 AND offered_seat_id = $2 AND status = 'offered'`
   - If found, it marks that waitlist entry as `expired` in PostgreSQL.
   - It then recursively calls `promoteNextInWaitlist(eventId, seatId, category)`, popping the next user in line, sending them an email, and locking the seat again for another 15 minutes.
   - This forms an elegant cascading chain of promotions that handles timeouts in a fully event-driven, non-blocking manner.

---

## 3. Production Scaling Considerations

To scale this ticketing platform to support massive ticket sales (e.g., millions of active users), the following adjustments are required:

### 1. Redis Cluster & Sentinel
In production, a single Redis instance becomes a single point of failure and a throughput bottleneck.
- **Redis Sentinel**: Provides high availability. If the primary Redis instance crashes, Sentinel automatically promotes a replica to primary.
- **Redis Sharding/Cluster**: Distributes keys across multiple Redis nodes. Keys are partitioned using hash slots. By naming keys like `seat:{eventId}:seatId`, we can use Redis hash tags `{eventId}` to ensure all seats for a single event are co-located on the same Redis shard, permitting multi-key commands or bulk operations on a per-event basis while scaling horizontally.

### 2. Socket.IO Horizontal Scaling (Redis Adapter)
By default, Socket.IO stores connection states in memory. If we scale the backend horizontally across multiple server instances behind a load balancer, clients connected to Server A will not receive broadcasts sent by Server B.
- To resolve this, we mount the **@socket.io/redis-adapter**.
- When Server B broadcasts a seat update, it publishes the event to a Redis Pub/Sub channel. All backend servers subscribed to that channel receive the message and broadcast it to their locally connected clients.

### 3. Database Scaling
- **Read Replicas**: Bookings history, venue layouts, and revenue views can be queried from read replicas, freeing up the primary database to handle write transactions (inserting bookings, creating holds, updating waitlist statuses).
- **Partitioning**: The `bookings` and `waitlist` tables can be partitioned by `event_id`, which segments database indexes and disk storage per event, keeping write performance fast even with millions of past bookings.
