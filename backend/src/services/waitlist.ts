import jwt from 'jsonwebtoken';
import { db } from '../config/db';
import { redisClient } from '../config/redis';
import { env } from '../config/env';
import { sendWaitlistOfferEmail } from './email';
import { broadcastSeatUpdate } from './socket';

export async function promoteNextInWaitlist(eventId: number, seatId: number, category: string): Promise<boolean> {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    // Find the oldest waitlist entry with 'waiting' status for this event and category
    const waitlistResult = await client.query(
      `SELECT w.*, u.email 
       FROM waitlist w
       JOIN users u ON w.user_id = u.id
       WHERE w.event_id = $1 AND w.category = $2 AND w.status = 'waiting'
       ORDER BY w.created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [eventId, category]
    );

    if (waitlistResult.rows.length === 0) {
      // No one is on the waitlist
      await client.query('COMMIT');
      
      // Ensure any leftover Redis keys are deleted and broadcast seat is available
      const redisKey = `seat:${eventId}:${seatId}`;
      await redisClient.del(redisKey);
      broadcastSeatUpdate(eventId, seatId, 'available');
      
      console.log(`No waitlist entries found for event=${eventId}, seatId=${seatId}, category=${category}. Seat is now fully available.`);
      return false;
    }

    const nextWaitlistEntry = waitlistResult.rows[0];
    const waitlistId = nextWaitlistEntry.id;
    const userId = nextWaitlistEntry.user_id;
    const userEmail = nextWaitlistEntry.email;

    // Update waitlist entry to 'offered' and assign the seat
    await client.query(
      `UPDATE waitlist 
       SET status = 'offered', offered_seat_id = $1, offered_at = NOW() 
       WHERE id = $2`,
      [seatId, waitlistId]
    );

    // Get event details for the email
    const eventResult = await client.query('SELECT name FROM events WHERE id = $1', [eventId]);
    const eventName = eventResult.rows[0]?.name || 'Your Event';

    // Acquire Redis lock for 15 minutes (900 seconds)
    // The value stores the waitlist information to verify on confirm
    const redisKey = `seat:${eventId}:${seatId}`;
    const redisValue = `offer:${waitlistId}:${userId}`;
    const lockAcquired = await redisClient.set(redisKey, redisValue, {
      NX: true,
      EX: 900,
    });

    if (!lockAcquired) {
      // In the rare case that the Redis lock is already acquired, abort
      console.warn(`Failed to acquire Redis lock for waitlist offer: ${redisKey}`);
      await client.query('ROLLBACK');
      return false;
    }

    await client.query('COMMIT');

    // Generate confirmation JWT token (expires in 15 mins)
    const token = jwt.sign(
      { waitlistId, userId, seatId, eventId },
      env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const confirmLink = `${env.FRONTEND_URL}/confirm-waitlist?token=${token}`;

    // Send email to customer
    await sendWaitlistOfferEmail(userEmail, eventName, category, confirmLink);

    // Broadcast seat status update to all users
    broadcastSeatUpdate(eventId, seatId, 'offered', userId);

    console.log(`Successfully promoted waitlist entry ID ${waitlistId} (User ${userEmail}) for event ${eventId}, seat ${seatId}.`);
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error promoting waitlist:', error);
    return false;
  } finally {
    client.release();
  }
}

export async function handleOfferExpiration(waitlistId: number) {
  try {
    console.log(`Handling expiration for waitlist offer ID ${waitlistId}...`);
    // Find the offered waitlist entry
    const result = await db.query(
      `SELECT * FROM waitlist WHERE id = $1 AND status = 'offered'`,
      [waitlistId]
    );

    if (result.rows.length === 0) {
      console.log(`Waitlist entry ${waitlistId} is no longer in offered status (might have been booked or manually expired).`);
      return;
    }

    const { event_id, offered_seat_id, category } = result.rows[0];

    // Mark waitlist entry as expired
    await db.query(
      `UPDATE waitlist SET status = 'expired' WHERE id = $1`,
      [waitlistId]
    );

    console.log(`Marked waitlist entry ${waitlistId} as expired.`);

    // Cascade: promote the next in line for this seat
    if (offered_seat_id) {
      await promoteNextInWaitlist(event_id, offered_seat_id, category);
    }
  } catch (error) {
    console.error(`Error handling expiration for waitlist entry ${waitlistId}:`, error);
  }
}
