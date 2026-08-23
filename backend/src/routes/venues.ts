import { Response } from 'express';
import { Router } from 'express';
import { db } from '../config/db';
import { authenticateJWT, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

// Helper to convert row index to letter (1 -> A, 2 -> B, etc.)
function getRowLetter(index: number): string {
  let letter = '';
  let temp = index;
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }
  return letter;
}

// POST Create Venue (Admin Only)
// Body: name, rowsCount, colsCount, rowCategories: { 'A': 'VIP', 'B': 'Premium', 'default': 'Standard' }
router.post('/', authenticateJWT, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { name, rowsCount, colsCount, rowCategories } = req.body;

  if (!name || !rowsCount || !colsCount) {
    return res.status(400).json({ error: 'Name, rowsCount, and colsCount are required' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Create the venue
    const venueResult = await client.query(
      'INSERT INTO venues (name, rows_count, cols_count) VALUES ($1, $2, $3) RETURNING *',
      [name, rowsCount, colsCount]
    );
    const newVenue = venueResult.rows[0];

    // Generate seats
    const categoriesMap = rowCategories || { default: 'Standard' };
    const defaultCategory = categoriesMap.default || 'Standard';

    for (let r = 1; r <= rowsCount; r++) {
      const rowLetter = getRowLetter(r);
      const category = categoriesMap[rowLetter] || defaultCategory;

      for (let c = 1; c <= colsCount; c++) {
        await client.query(
          'INSERT INTO seats (venue_id, row_name, col_number, category) VALUES ($1, $2, $3, $4)',
          [newVenue.id, rowLetter, c, category]
        );
      }
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Venue and seat layout created successfully',
      venue: newVenue,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating venue layout:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET list all venues (Admin & Organiser)
router.get('/', authenticateJWT, requireRole(['admin', 'organiser']), async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM venues ORDER BY id DESC');
    return res.json(result.rows);
  } catch (error) {
    console.error('Error listing venues:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
