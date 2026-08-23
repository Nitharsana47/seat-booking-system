import { Response } from 'express';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { db } from '../config/db';
import { redisClient } from '../config/redis';
import { env } from '../config/env';
import { authenticateJWT, requireRole, AuthRequest } from '../middleware/auth';
import { broadcastSeatUpdate } from '../services/socket';
import { sendTicketEmail } from '../services/email';

const router = Router();

// GET Seat layout with live status
router.get('/layout', async (req, res) => {
  const eventId = parseInt(req.query.eventId as string, 10);

  if (isNaN(eventId)) {
    return res.status(400).json({ error: 'Valid eventId query parameter is required' });
  }

  try {
    // Get event and venue information
    const eventRes = await db.query(
      `SELECT e.*, v.id as venue_id, v.rows_count, v.cols_count 
       FROM events e
       JOIN venues v ON e.venue_id = v.id
       WHERE e.id = $1`,
      [eventId]
    );

    if (eventRes.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventRes.rows[0];
    const venueId = event.venue_id;

    // Get all seats for the venue
    const seatsRes = await db.query(
      `SELECT s.id, s.row_name, s.col_number, s.category, COALESCE(p.price, 0) as price
       FROM seats s
       LEFT JOIN event_seat_pricing p ON p.event_id = $1 AND p.category = s.category
       WHERE s.venue_id = $2
       ORDER BY s.row_name ASC, s.col_number ASC`,
      [eventId, venueId]
    );

    const seats = seatsRes.rows.map(row => ({
      ...row,
      price: parseFloat(row.price),
    }));

    // Get all active bookings
    const bookingsRes = await db.query(
      `SELECT seat_id FROM bookings WHERE event_id = $1 AND status = 'booked'`,
      [eventId]
    );
    const bookedSeatIds = new Set(bookingsRes.rows.map(b => b.seat_id));

    // Get all active Redis holds/offers
    const redisKeys = await redisClient.keys(`seat:${eventId}:*`);
    const holdsMap: Record<number, { status: 'held' | 'offered'; userId: number; waitlistId?: number }> = {};

    if (redisKeys.length > 0) {
      const values = await redisClient.mGet(redisKeys);
      redisKeys.forEach((key, index) => {
        const seatId = parseInt(key.split(':')[2], 10);
        const val = values[index];
        if (val) {
          if (val.startsWith('hold:')) {
            const userId = parseInt(val.split(':')[1], 10);
            holdsMap[seatId] = { status: 'held', userId };
          } else if (val.startsWith('offer:')) {
            const waitlistId = parseInt(val.split(':')[1], 10);
            const userId = parseInt(val.split(':')[2], 10);
            holdsMap[seatId] = { status: 'offered', userId, waitlistId };
          }
        }
      });
    }

    // Map seats to their live status
    const liveSeats = seats.map(seat => {
      let status: 'available' | 'held' | 'offered' | 'booked' = 'available';
      let heldBy: number | null = null;
      let waitlistId: number | null = null;

      if (bookedSeatIds.has(seat.id)) {
        status = 'booked';
      } else if (holdsMap[seat.id]) {
        status = holdsMap[seat.id].status;
        heldBy = holdsMap[seat.id].userId;
        waitlistId = holdsMap[seat.id].waitlistId || null;
      }

      return {
        ...seat,
        status,
        heldBy,
        waitlistId,
      };
    });

    return res.json({
      eventId,
      venueName: event.name,
      rowsCount: event.rows_count,
      colsCount: event.cols_count,
      seats: liveSeats,
    });
  } catch (error) {
    console.error('Error fetching seat layout:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST Hold seat (Customer Only)
router.post('/hold', authenticateJWT, requireRole(['customer']), async (req: AuthRequest, res: Response) => {
  const { eventId, seatId } = req.body;
  const userId = req.user?.id;

  if (!eventId || !seatId) {
    return res.status(400).json({ error: 'eventId and seatId are required' });
  }

  try {
    // 1. Verify seat isn't booked in Postgres
    const bookingCheck = await db.query(
      `SELECT * FROM bookings WHERE event_id = $1 AND seat_id = $2 AND status = 'booked'`,
      [eventId, seatId]
    );

    if (bookingCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Seat is already booked' });
    }

    // 2. Try to acquire Redis lock for 10 minutes (600 seconds)
    const redisKey = `seat:${eventId}:${seatId}`;
    const redisValue = `hold:${userId}`;

    const acquired = await redisClient.set(redisKey, redisValue, {
      NX: true,
      EX: 600,
    });

    if (!acquired) {
      return res.status(409).json({ error: 'Seat is already held by another user' });
    }

    // 3. Broadcast seat status change
    broadcastSeatUpdate(eventId, seatId, 'held', userId);

    return res.json({
      message: 'Seat hold acquired successfully',
      expiresIn: 600,
    });
  } catch (error) {
    console.error('Error holding seat:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST Release seat (Customer Only)
router.post('/release', authenticateJWT, requireRole(['customer']), async (req: AuthRequest, res: Response) => {
  const { eventId, seatId } = req.body;
  const userId = req.user?.id;

  if (!eventId || !seatId) {
    return res.status(400).json({ error: 'eventId and seatId are required' });
  }

  try {
    const redisKey = `seat:${eventId}:${seatId}`;
    const currentValue = await redisClient.get(redisKey);

    if (!currentValue) {
      return res.status(400).json({ error: 'Seat is not currently held' });
    }

    if (currentValue !== `hold:${userId}`) {
      return res.status(403).json({ error: 'You do not hold this seat' });
    }

    // Delete Redis key
    await redisClient.del(redisKey);

    // Broadcast update
    broadcastSeatUpdate(eventId, seatId, 'available');

    return res.json({ message: 'Seat released successfully' });
  } catch (error) {
    console.error('Error releasing seat:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST Join Waitlist (Customer Only)
router.post('/waitlist', authenticateJWT, requireRole(['customer']), async (req: AuthRequest, res: Response) => {
  const { eventId, category } = req.body;
  const userId = req.user?.id;

  if (!eventId || !category) {
    return res.status(400).json({ error: 'eventId and category are required' });
  }

  try {
    // Verify event exists
    const eventCheck = await db.query('SELECT venue_id FROM events WHERE id = $1', [eventId]);
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const venueId = eventCheck.rows[0].venue_id;

    // Check if there are active free seats in this category
    // Total seats in category for this venue
    const totalSeatsRes = await db.query(
      'SELECT COUNT(*) FROM seats WHERE venue_id = $1 AND category = $2',
      [venueId, category]
    );
    const totalSeats = parseInt(totalSeatsRes.rows[0].count, 10);

    if (totalSeats === 0) {
      return res.status(400).json({ error: 'No seats in this category exist at this venue' });
    }

    // Booked seats in category
    const bookedSeatsRes = await db.query(
      `SELECT COUNT(*) FROM bookings b
       JOIN seats s ON b.seat_id = s.id
       WHERE b.event_id = $1 AND s.category = $2 AND b.status = 'booked'`,
      [eventId, category]
    );
    const bookedSeats = parseInt(bookedSeatsRes.rows[0].count, 10);

    // If there are still free seats (total > booked), user should book normally instead of waitlisting
    if (bookedSeats < totalSeats) {
      return res.status(400).json({ error: 'Seats are still available in this category. Book directly!' });
    }

    // Check if user is already on waitlist for this event and category in 'waiting' or 'offered' status
    const activeWaitlistCheck = await db.query(
      `SELECT id FROM waitlist 
       WHERE event_id = $1 AND category = $2 AND user_id = $3 AND status IN ('waiting', 'offered')`,
      [eventId, category, userId]
    );

    if (activeWaitlistCheck.rows.length > 0) {
      return res.status(400).json({ error: 'You are already on the active waitlist for this category' });
    }

    // Insert waitlist entry
    const waitlistResult = await db.query(
      `INSERT INTO waitlist (event_id, category, user_id, status) 
       VALUES ($1, $2, $3, 'waiting') RETURNING *`,
      [eventId, category, userId]
    );

    return res.status(201).json({
      message: 'Joined waitlist successfully',
      waitlist: waitlistResult.rows[0],
    });
  } catch (error) {
    console.error('Error joining waitlist:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST Confirm waitlist offer (signed token check)
router.post('/waitlist/confirm', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    // 1. Verify token
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      waitlistId: number;
      userId: number;
      seatId: number;
      eventId: number;
    };

    const { waitlistId, userId, seatId, eventId } = decoded;

    // 2. Verify Redis key is still in offered state for this user/waitlist
    const redisKey = `seat:${eventId}:${seatId}`;
    const redisVal = await redisClient.get(redisKey);

    if (!redisVal || redisVal !== `offer:${waitlistId}:${userId}`) {
      // Offer expired or taken
      return res.status(410).json({ error: 'This waitlist offer has expired' });
    }

    // Fetch user email
    const userRes = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
    const userEmail = userRes.rows[0]?.email;

    // Fetch event and pricing details
    const eventRes = await db.query(
      `SELECT e.name, e.event_date, e.event_time, s.row_name, s.col_number, s.category, p.price
       FROM events e
       JOIN seats s ON s.id = $1
       JOIN event_seat_pricing p ON p.event_id = e.id AND p.category = s.category
       WHERE e.id = $2`,
      [seatId, eventId]
    );

    if (eventRes.rows.length === 0) {
      return res.status(400).json({ error: 'Event or pricing not found' });
    }

    const { name: eventName, event_date, event_time, row_name, col_number, category, price } = eventRes.rows[0];
    const seatInfo = `Row ${row_name}, Seat ${col_number} (${category})`;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Double check booking doesn't exist
      const doubleBookRes = await client.query(
        'SELECT * FROM bookings WHERE event_id = $1 AND seat_id = $2 AND status = \'booked\' FOR UPDATE',
        [eventId, seatId]
      );

      if (doubleBookRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Seat is already booked' });
      }

      // Generate booking reference
      const bookingRef = `BK-${eventId}-${seatId}-${Math.floor(1000 + Math.random() * 9000)}`;

      // Create booking
      const bookingResult = await client.query(
        `INSERT INTO bookings (event_id, seat_id, user_id, booking_reference, price_paid, status) 
         VALUES ($1, $2, $3, $4, $5, 'booked') RETURNING *`,
        [eventId, seatId, userId, bookingRef, price]
      );

      // Update waitlist entry to 'booked'
      await client.query(
        `UPDATE waitlist SET status = 'booked' WHERE id = $1`,
        [waitlistId]
      );

      await client.query('COMMIT');

      // Delete Redis lock
      await redisClient.del(redisKey);

      // Generate QR Code data url
      const qrCodeDataUrl = await QRCode.toDataURL(bookingRef);

      // Send email in background
      if (userEmail) {
        const formattedDate = `${new Date(event_date).toLocaleDateString()} at ${event_time}`;
        sendTicketEmail(userEmail, bookingRef, eventName, formattedDate, seatInfo, qrCodeDataUrl).catch(console.error);
      }

      // Broadcast Socket.IO update
      broadcastSeatUpdate(eventId, seatId, 'booked');

      return res.json({
        message: 'Booking completed successfully from waitlist!',
        booking: bookingResult.rows[0],
      });
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(410).json({ error: 'Invalid or expired promotion token' });
    }
    console.error('Error confirming waitlist booking:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
