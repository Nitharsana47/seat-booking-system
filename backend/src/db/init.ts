import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { db } from '../config/db';

async function seedDefaultEvent() {
  try {
    // Check if venue already exists to prevent duplicate seeding
    const venueCheck = await db.query("SELECT id FROM venues WHERE name = 'Grand Arena'");
    if (venueCheck.rows.length > 0) {
      console.log('Default venue "Grand Arena" already exists. Skipping event seeding.');
      return;
    }

    // Get or create organiser ID
    let orgId: number;
    const orgRes = await db.query("SELECT id FROM users WHERE email = 'organiser@ticket.com'");
    if (orgRes.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('password123', 10);
      const newOrg = await db.query(
        "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
        ['organiser@ticket.com', hashedPassword, 'organiser']
      );
      orgId = newOrg.rows[0].id;
    } else {
      orgId = orgRes.rows[0].id;
    }

    // Seed Venue
    console.log('Seeding default venue: "Grand Arena"...');
    const venueRes = await db.query(
      "INSERT INTO venues (name, rows_count, cols_count) VALUES ($1, $2, $3) RETURNING id",
      ['Grand Arena', 5, 6]
    );
    const venueId = venueRes.rows[0].id;

    // Seed Seats
    const rowCategories: Record<string, string> = {
      A: 'VIP',
      B: 'VIP',
      C: 'Premium',
    };

    for (let r = 1; r <= 5; r++) {
      const rowLetter = String.fromCharCode(65 + r - 1);
      const category = rowCategories[rowLetter] || 'Standard';
      for (let c = 1; c <= 6; c++) {
        await db.query(
          "INSERT INTO seats (venue_id, row_name, col_number, category) VALUES ($1, $2, $3, $4)",
          [venueId, rowLetter, c, category]
        );
      }
    }

    // Seed Event
    console.log('Seeding default event: "Tomorrowland Music Festival 2026"...');
    const eventRes = await db.query(
      "INSERT INTO events (name, venue_id, organiser_id, event_date, event_time) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      ['Tomorrowland Music Festival 2026', venueId, orgId, '2026-10-24', '18:00:00']
    );
    const eventId = eventRes.rows[0].id;

    // Seed Pricing
    await db.query("INSERT INTO event_seat_pricing (event_id, category, price) VALUES ($1, $2, $3)", [eventId, 'VIP', 250.00]);
    await db.query("INSERT INTO event_seat_pricing (event_id, category, price) VALUES ($1, $2, $3)", [eventId, 'Premium', 150.00]);
    await db.query("INSERT INTO event_seat_pricing (event_id, category, price) VALUES ($1, $2, $3)", [eventId, 'Standard', 80.00]);

    console.log('Default venue, seats grid, and music event seeded successfully.');
  } catch (err) {
    console.error('Error seeding default venue/event:', err);
  }
}

export async function initDb() {
  try {
    // Check if tables are already initialized to prevent dropping data in production
    const tableCheck = await db.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'users'
      )`
    );
    const tablesExist = tableCheck.rows[0].exists;

    if (tablesExist) {
      console.log('Database tables already exist. Skipping schema application.');
      
      // Seed default event if Tomorrowland is missing
      const eventCheck = await db.query("SELECT id FROM events WHERE name = 'Tomorrowland Music Festival 2026'");
      if (eventCheck.rows.length === 0) {
        await seedDefaultEvent();
      }
      return;
    }

    console.log('Initializing database schema...');
    
    // Read schema.sql
    let schemaPath = path.resolve(__dirname, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      schemaPath = path.resolve(__dirname, '../../src/db/schema.sql');
    }
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute schema queries
    await db.query(schemaSql);
    console.log('Database schema applied successfully.');

    // Seed default users
    console.log('Seeding default users...');
    const hashedPassword = await bcrypt.hash('password123', 10);
    
    await db.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)",
      ['admin@ticket.com', hashedPassword, 'admin']
    );

    await db.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)",
      ['organiser@ticket.com', hashedPassword, 'organiser']
    );

    await db.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)",
      ['customer@ticket.com', hashedPassword, 'customer']
    );

    console.log('Default users seeded successfully.');

    // Seed default venue & event
    await seedDefaultEvent();

  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}
