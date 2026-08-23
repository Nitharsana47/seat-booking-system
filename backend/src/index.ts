import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { env } from './config/env';
import { db } from './config/db';
import { initRedis } from './config/redis';
import { initEmailService } from './services/email';
import { initSocket } from './services/socket';
import { initDb } from './db/init';

// Import routes
import authRoutes from './routes/auth';
import venueRoutes from './routes/venues';
import eventRoutes from './routes/events';
import seatRoutes from './routes/seats';
import bookingRoutes from './routes/bookings';

const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO
initSocket(httpServer);

// Middleware
app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());

// Hello World / Health Check endpoint
app.get('/api/health', (req, res) => {
  res.json({ message: 'Hello World from Ticketing Backend!' });
});

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/venues', venueRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/seats', seatRoutes);
app.use('/api/bookings', bookingRoutes);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

async function startServer() {
  try {
    // 1. Initialize Postgres Schema and Seed default data
    await initDb();
    
    // 2. Initialize Redis connections & keyspace event subscriber
    await initRedis();
    
    // 3. Initialize Nodemailer (SMTP / Ethereal)
    await initEmailService();

    // 4. Start HTTP & Socket server
    httpServer.listen(env.PORT, () => {
      console.log(`=================================`);
      console.log(`🚀 Backend Server running on port ${env.PORT}`);
      console.log(`🌐 Environment: ${env.NODE_ENV}`);
      console.log(`=================================`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start
startServer();
