import { createClient } from 'redis';
import { env } from './env';

export const redisClient = createClient({
  url: env.REDIS_URL,
});

export const redisSubClient = createClient({
  url: env.REDIS_URL,
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisSubClient.on('error', (err) => console.error('Redis Subscriber Client Error', err));

export async function initRedis() {
  try {
    console.log('Connecting to Redis...');
    await redisClient.connect();
    await redisSubClient.connect();
    console.log('Connected to Redis successfully.');

    // Enable Keyspace notifications (Key Expiry events) programmatically
    try {
      await redisClient.configSet('notify-keyspace-events', 'KEx');
      console.log('Redis keyspace notifications configured (KEx).');
    } catch (configError) {
      console.warn('Warning: Could not set notify-keyspace-events via CONFIG SET. Ensure it is enabled in redis.conf.', configError);
    }

    // Subscribe to expired keyspace events
    const expiredChannel = '__keyevent@0__:expired';
    await redisSubClient.subscribe(expiredChannel, async (key) => {
      console.log(`Redis expired event received for key: ${key}`);
      
      if (key.startsWith('seat:')) {
        const parts = key.split(':');
        const eventId = parseInt(parts[1], 10);
        const seatId = parseInt(parts[2], 10);

        if (!isNaN(eventId) && !isNaN(seatId)) {
          try {
            // Dynamic imports to prevent circular dependencies
            const { db } = await import('./db');
            const { promoteNextInWaitlist } = await import('../services/waitlist');
            const { broadcastSeatUpdate } = await import('../services/socket');

            // Query DB to see if this expired key was a waitlist offer
            const res = await db.query(
              "SELECT id, category FROM waitlist WHERE event_id = $1 AND offered_seat_id = $2 AND status = 'offered'",
              [eventId, seatId]
            );

            if (res.rows.length > 0) {
              const waitlistId = res.rows[0].id;
              const category = res.rows[0].category;
              
              console.log(`Waitlist offer expired for waitlistId=${waitlistId}, eventId=${eventId}, seatId=${seatId}`);
              
              // Mark the expired waitlist entry as expired
              await db.query("UPDATE waitlist SET status = 'expired' WHERE id = $1", [waitlistId]);
              
              // Promote next person in line
              await promoteNextInWaitlist(eventId, seatId, category);
            } else {
              // Regular seat hold expired, broadcast available
              console.log(`Regular seat hold expired: eventId=${eventId}, seatId=${seatId}`);
              broadcastSeatUpdate(eventId, seatId, 'available');
            }
          } catch (err) {
            console.error('Error handling expired seat key:', err);
          }
        }
      }
    });
    console.log(`Subscribed to Redis expired channel: ${expiredChannel}`);
  } catch (error) {
    console.error('Error connecting to Redis:', error);
    throw error;
  }
}
