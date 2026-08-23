import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { env } from '../config/env';

export let io: SocketServer | null = null;

export function initSocket(server: HttpServer) {
  io = new SocketServer(server, {
    cors: {
      origin: env.FRONTEND_URL,
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    console.log(`Socket client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`Socket client disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function broadcastSeatUpdate(eventId: number, seatId: number, status: 'available' | 'held' | 'offered' | 'booked', userId?: number | null) {
  if (io) {
    console.log(`Broadcasting seat_update: eventId=${eventId}, seatId=${seatId}, status=${status}, userId=${userId}`);
    io.emit('seat_update', { eventId, seatId, status, userId });
  } else {
    console.warn('Socket.IO not initialized. Cannot broadcast seat update.');
  }
}
