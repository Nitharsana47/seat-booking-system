import { Response } from 'express';
import { Router } from 'express';
import { db } from '../config/db';
import { authenticateJWT, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

// POST Create Event (Organiser Only)
// Body: name, venueId, eventDate, eventTime, pricing: { 'VIP': 150, 'Premium': 100, 'Standard': 50 }
router.post('/', authenticateJWT, requireRole(['organiser']), async (req: AuthRequest, res: Response) => {
  const { name, venueId, eventDate, eventTime, pricing } = req.body;
  const organiserId = req.user?.id;

  if (!name || !venueId || !eventDate || !eventTime || !pricing) {
    return res.status(400).json({ error: 'Name, venueId, eventDate, eventTime, and pricing are required' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Verify venue exists
    const venueCheck = await client.query('SELECT * FROM venues WHERE id = $1', [venueId]);
    if (venueCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Venue not found' });
    }

    // Insert the event
    const eventResult = await client.query(
      `INSERT INTO events (name, venue_id, organiser_id, event_date, event_time) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, venueId, organiserId, eventDate, eventTime]
    );
    const newEvent = eventResult.rows[0];

    // Insert pricing for each category
    const categories = Object.keys(pricing);
    for (const category of categories) {
      const price = pricing[category];
      await client.query(
        `INSERT INTO event_seat_pricing (event_id, category, price) 
         VALUES ($1, $2, $3)`,
        [newEvent.id, category, price]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Event and pricing created successfully',
      event: newEvent,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating event:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET list all events (Public)
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.*, v.name as venue_name, v.rows_count, v.cols_count
      FROM events e
      JOIN venues v ON e.venue_id = v.id
      ORDER BY e.event_date ASC, e.event_time ASC
    `);
    
    // Attach pricing information to each event
    const events = [];
    for (const eventRow of result.rows) {
      const pricingRes = await db.query(
        'SELECT category, price FROM event_seat_pricing WHERE event_id = $1',
        [eventRow.id]
      );
      
      const pricingMap: Record<string, number> = {};
      pricingRes.rows.forEach(r => {
        pricingMap[r.category] = parseFloat(r.price);
      });

      events.push({
        ...eventRow,
        pricing: pricingMap,
      });
    }

    return res.json(events);
  } catch (error) {
    console.error('Error fetching events:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET specific event details with pricing (Public)
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const eventRes = await db.query(`
      SELECT e.*, v.name as venue_name, v.rows_count, v.cols_count
      FROM events e
      JOIN venues v ON e.venue_id = v.id
      WHERE e.id = $1
    `, [id]);

    if (eventRes.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventRes.rows[0];

    const pricingRes = await db.query(
      'SELECT category, price FROM event_seat_pricing WHERE event_id = $1',
      [id]
    );
    
    const pricingMap: Record<string, number> = {};
    pricingRes.rows.forEach(r => {
      pricingMap[r.category] = parseFloat(r.price);
    });

    return res.json({
      ...event,
      pricing: pricingMap,
    });
  } catch (error) {
    console.error('Error fetching event detail:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
