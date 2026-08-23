-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS waitlist CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS event_seat_pricing CASCADE;
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS seats CASCADE;
DROP TABLE IF EXISTS venues CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Drop Enums if they exist
DROP TYPE IF EXISTS user_role CASCADE;

-- Enums for Roles
CREATE TYPE user_role AS ENUM ('customer', 'organiser', 'admin');

-- Users Table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role user_role NOT NULL DEFAULT 'customer',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Venues Table
CREATE TABLE venues (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  rows_count INT NOT NULL,
  cols_count INT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seats Table
CREATE TABLE seats (
  id SERIAL PRIMARY KEY,
  venue_id INT REFERENCES venues(id) ON DELETE CASCADE,
  row_name VARCHAR(10) NOT NULL,
  col_number INT NOT NULL,
  category VARCHAR(50) NOT NULL, -- e.g., 'VIP', 'Premium', 'Standard'
  UNIQUE(venue_id, row_name, col_number)
);

-- Events Table
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  venue_id INT REFERENCES venues(id) ON DELETE CASCADE,
  organiser_id INT REFERENCES users(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  event_time TIME NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Event Seat Pricing Table
CREATE TABLE event_seat_pricing (
  event_id INT REFERENCES events(id) ON DELETE CASCADE,
  category VARCHAR(50) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  PRIMARY KEY (event_id, category)
);

-- Bookings Table
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  event_id INT REFERENCES events(id) ON DELETE CASCADE,
  seat_id INT REFERENCES seats(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'booked', -- 'booked', 'cancelled'
  booking_reference VARCHAR(100) UNIQUE NOT NULL,
  price_paid DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Waitlist Table
CREATE TABLE waitlist (
  id SERIAL PRIMARY KEY,
  event_id INT REFERENCES events(id) ON DELETE CASCADE,
  category VARCHAR(50) NOT NULL,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting', -- 'waiting', 'offered', 'expired', 'booked'
  offered_seat_id INT REFERENCES seats(id) ON DELETE SET NULL,
  offered_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
