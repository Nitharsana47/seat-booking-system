import { Response } from 'express';
import { Router } from 'express';
import QRCode from 'qrcode';
import { db } from '../config/db';
import { redisClient } from '../config/redis';
import { authenticateJWT, AuthRequest, requireRole } from '../middleware/auth';
import { broadcastSeatUpdate } from '../services/socket';
import { sendTicketEmail } from '../services/email';
import { promoteNextInWaitlist } from '../services/waitlist';

const router = Router();

// POST Checkout (Book held seat - Customer Only)
router.post('/checkout', authenticateJWT, requireRole(['customer']), async (req: AuthRequest, res: Response) => {
  const { eventId, seatId } = req.body;
  const userId = req.user?.id;

  if (!eventId || !seatId) {
    return res.status(400).json({ error: 'eventId and seatId are required' });
  }

  try {
    // 1. Verify user holds the seat in Redis
    const redisKey = `seat:${eventId}:${seatId}`;
    const redisValue = await redisClient.get(redisKey);

    if (!redisValue || (redisValue !== `hold:${userId}` && !redisValue.startsWith(`offer:`))) {
      return res.status(400).json({ error: 'Seat hold has expired or is not held by you' });
    }

    // 2. Fetch seat and pricing details
    const seatRes = await db.query(
      `SELECT s.category, s.row_name, s.col_number, e.name as event_name, e.event_date, e.event_time, p.price
       FROM seats s
       JOIN events e ON e.id = $1
       JOIN event_seat_pricing p ON p.event_id = e.id AND p.category = s.category
       WHERE s.id = $2`,
      [eventId, seatId]
    );

    if (seatRes.rows.length === 0) {
      return res.status(400).json({ error: 'Seat or pricing not found' });
    }

    const { category, row_name, col_number, event_name, event_date, event_time, price } = seatRes.rows[0];
    const seatInfo = `Row ${row_name}, Seat ${col_number} (${category})`;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Double check seat is not already booked in Postgres
      const bookingCheck = await client.query(
        `SELECT * FROM bookings WHERE event_id = $1 AND seat_id = $2 AND status = 'booked' FOR UPDATE`,
        [eventId, seatId]
      );

      if (bookingCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Seat is already booked' });
      }

      // Generate booking reference
      const bookingRef = `BK-${eventId}-${seatId}-${Math.floor(1000 + Math.random() * 9000)}`;

      // Insert booking row
      const result = await client.query(
        `INSERT INTO bookings (event_id, seat_id, user_id, booking_reference, price_paid, status) 
         VALUES ($1, $2, $3, $4, $5, 'booked') RETURNING *`,
        [eventId, seatId, userId, bookingRef, price]
      );

      await client.query('COMMIT');

      // 3. Delete Redis hold key
      await redisClient.del(redisKey);

      // 4. Generate QR code
      const qrCodeDataUrl = await QRCode.toDataURL(bookingRef);

      // 5. Send Email confirmation (non-blocking)
      if (req.user?.email) {
        const formattedDate = `${new Date(event_date).toLocaleDateString()} at ${event_time}`;
        sendTicketEmail(req.user.email, bookingRef, event_name, formattedDate, seatInfo, qrCodeDataUrl).catch(console.error);
      }

      // 6. Broadcast live update
      broadcastSeatUpdate(eventId, seatId, 'booked');

      return res.status(201).json({
        message: 'Seat booked successfully!',
        booking: result.rows[0],
      });
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST Cancel Booking (triggers waitlist flow)
router.post('/cancel/:id', authenticateJWT, async (req: AuthRequest, res: Response) => {
  const bookingId = parseInt(req.params.id, 10);
  const userId = req.user?.id;
  const userRole = req.user?.role;

  if (isNaN(bookingId)) {
    return res.status(400).json({ error: 'Valid booking ID is required' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Retrieve booking details
    const bookingRes = await client.query(
      `SELECT b.*, s.category 
       FROM bookings b
       JOIN seats s ON b.seat_id = s.id
       WHERE b.id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingRes.rows[0];

    // Authorization: User must be customer who owns it, or organiser/admin
    if (userRole === 'customer' && booking.user_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden: You do not own this booking' });
    }

    if (booking.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Booking is already cancelled' });
    }

    // Update status to cancelled
    await client.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
      [bookingId]
    );

    await client.query('COMMIT');

    console.log(`Booking ID ${bookingId} cancelled. Promoting next waitlisted user...`);

    // Trigger waitlist flow: pop the oldest waitlist entry
    // promoteNextInWaitlist automatically locks the seat for 15 mins in Redis and emails them
    // If no waitlist entry exists, it frees up the seat and broadcasts available
    await promoteNextInWaitlist(booking.event_id, booking.seat_id, booking.category);

    return res.json({ message: 'Booking cancelled successfully and waitlist processed' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Cancellation error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET My Bookings (Customer Only)
router.get('/my-bookings', authenticateJWT, requireRole(['customer']), async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;

  try {
    const result = await db.query(
      `SELECT b.id, b.booking_reference, b.price_paid, b.status, b.created_at,
              e.id as event_id, e.name as event_name, e.event_date, e.event_time,
              s.row_name, s.col_number, s.category,
              v.name as venue_name
       FROM bookings b
       JOIN events e ON b.event_id = e.id
       JOIN seats s ON b.seat_id = s.id
       JOIN venues v ON e.venue_id = v.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [userId]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET Organiser Revenue View (Organiser Only)
router.get('/revenue', authenticateJWT, requireRole(['organiser']), async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  try {
    let queryText = '';
    let params: any[] = [];

    if (role === 'admin') {
      // Admin sees revenue for all events
      queryText = `
        SELECT e.id as event_id, e.name as event_name, e.event_date, e.event_time,
               COUNT(CASE WHEN b.status = 'booked' THEN 1 END) as total_bookings,
               COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.price_paid ELSE 0 END), 0) as total_revenue
        FROM events e
        LEFT JOIN bookings b ON e.id = b.event_id
        GROUP BY e.id, e.name, e.event_date, e.event_time
        ORDER BY total_revenue DESC
      `;
    } else {
      // Organiser only sees their own events
      queryText = `
        SELECT e.id as event_id, e.name as event_name, e.event_date, e.event_time,
               COUNT(CASE WHEN b.status = 'booked' THEN 1 END) as total_bookings,
               COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.price_paid ELSE 0 END), 0) as total_revenue
        FROM events e
        LEFT JOIN bookings b ON e.id = b.event_id
        WHERE e.organiser_id = $1
        GROUP BY e.id, e.name, e.event_date, e.event_time
        ORDER BY total_revenue DESC
      `;
      params = [userId];
    }

    const result = await db.query(queryText, params);

    // Format fields (convert strings to numbers)
    const formatted = result.rows.map(row => ({
      ...row,
      total_bookings: parseInt(row.total_bookings, 10),
      total_revenue: parseFloat(row.total_revenue),
    }));

    return res.json(formatted);
  } catch (error) {
    console.error('Error fetching revenue dashboard:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
