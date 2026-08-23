import React, { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './context/AuthContext';
import { 
  Ticket, Calendar, MapPin, LogOut, Shield, 
  CheckCircle2, AlertCircle, Clock 
} from 'lucide-react';

interface Event {
  id: number;
  name: string;
  venue_id: number;
  venue_name: string;
  event_date: string;
  event_time: string;
  rows_count: number;
  cols_count: number;
  pricing: Record<string, number>;
}

interface Venue {
  id: number;
  name: string;
  rows_count: number;
  cols_count: number;
}

interface Seat {
  id: number;
  row_name: string;
  col_number: number;
  category: string;
  price: number;
  status: 'available' | 'held' | 'offered' | 'booked';
  heldBy: number | null;
  waitlistId: number | null;
}

interface Booking {
  id: number;
  booking_reference: string;
  price_paid: number;
  status: 'booked' | 'cancelled';
  created_at: string;
  event_id: number;
  event_name: string;
  event_date: string;
  event_time: string;
  row_name: string;
  col_number: string;
  category: string;
  venue_name: string;
}

interface RevenueStat {
  event_id: number;
  event_name: string;
  event_date: string;
  event_time: string;
  total_bookings: number;
  total_revenue: number;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export default function App() {
  const { user, login, logout, loading, authenticatedFetch } = useAuth();
  const [activeTab, setActiveTab] = useState<'events' | 'bookings' | 'organiser' | 'admin'>('events');
  
  // Auth Form State
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'customer' | 'organiser' | 'admin'>('customer');
  const [authError, setAuthError] = useState('');

  // Data State
  const [events, setEvents] = useState<Event[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [venues, setVenues] = useState<Venue[]>([]);
  const [myBookings, setMyBookings] = useState<Booking[]>([]);
  const [revenueStats, setRevenueStats] = useState<RevenueStat[]>([]);
  
  // Selected Event & Seat Selection State
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedSeat, setSelectedSeat] = useState<Seat | null>(null);
  const [holdTimer, setHoldTimer] = useState<number>(0);
  
  // Create Venue State
  const [venueName, setVenueName] = useState('');
  const [venueRows, setVenueRows] = useState(5);
  const [venueCols, setVenueCols] = useState(6);
  const [vipRows, setVipRows] = useState('A,B');
  const [premiumRows, setPremiumRows] = useState('C');
  const [generatedVenuePreview, setGeneratedVenuePreview] = useState<{ name: string; rows: number; cols: number; vip: string[]; premium: string[] } | null>(null);
  
  // Create Event State
  const [eventName, setEventName] = useState('');
  const [selectedVenueId, setSelectedVenueId] = useState<number>(0);
  const [eventDate, setEventDate] = useState('');
  const [eventTime, setEventTime] = useState('');
  const [priceVip, setPriceVip] = useState(150);
  const [pricePremium, setPricePremium] = useState(90);
  const [priceStandard, setPriceStandard] = useState(50);

  // General Notification Banners
  const [banner, setBanner] = useState<{ type: 'success' | 'warning' | 'info'; message: string } | null>(null);
  
  // Waitlist Promotion Token (if URL contains token)
  const [promotionToken, setPromotionToken] = useState<string | null>(null);

  // 1. Fetch Initials
  useEffect(() => {
    fetchEvents();
    
    // Check if waitlist token is present in URL
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    if (token) {
      setPromotionToken(token);
      // Clean query parameter from URL
      window.history.replaceState({}, document.title, window.location.pathname);
      setBanner({ 
        type: 'info', 
        message: 'You have a pending waitlist offer! Please click "Confirm Waitlist Offer" below to purchase.' 
      });
    }
  }, []);

  // 2. Fetch dependencies based on role/login
  useEffect(() => {
    if (user) {
      fetchBookings();
      if (user.role === 'organiser') {
        fetchVenues();
        fetchRevenue();
      } else if (user.role === 'admin') {
        fetchVenues();
      }
    } else {
      setMyBookings([]);
      setRevenueStats([]);
      setVenues([]);
    }
  }, [user]);

  // 3. Connect Socket.IO
  useEffect(() => {
    const s = io(import.meta.env.VITE_WS_URL || 'http://localhost:5000');

    s.on('connect', () => {
      console.log('Socket connected successfully.');
    });

    s.on('seat_update', (data: { eventId: number; seatId: number; status: 'available' | 'held' | 'offered' | 'booked'; userId: number | null }) => {
      // If we are currently viewing this event, update the seat map state in real time!
      setSelectedEvent((currentEvent) => {
        if (currentEvent && currentEvent.id === data.eventId) {
          setSeats((currentSeats) => {
            return currentSeats.map((seat) => {
              if (seat.id === data.seatId) {
                return {
                  ...seat,
                  status: data.status,
                  heldBy: data.userId,
                };
              }
              return seat;
            });
          });
        }
        return currentEvent;
      });
    });

    return () => {
      s.disconnect();
    };
  }, []);

  // 4. Timer for held seat
  useEffect(() => {
    let interval: any;
    if (holdTimer > 0) {
      interval = setInterval(() => {
        setHoldTimer((prev) => {
          if (prev <= 1) {
            // Expired locally, clear selection
            setSelectedSeat(null);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [holdTimer]);

  const fetchEvents = async () => {
    try {
      const res = await fetch(`${API_URL}/api/events`);
      if (res.ok) {
        const data = await res.json();
        setEvents(data);
      }
    } catch (err) {
      console.error('Error fetching events:', err);
    }
  };

  const fetchVenues = async () => {
    try {
      const res = await authenticatedFetch(`${API_URL}/api/venues`);
      if (res.ok) {
        const data = await res.json();
        setVenues(data);
        if (data.length > 0 && selectedVenueId === 0) {
          setSelectedVenueId(data[0].id);
        }
      }
    } catch (err) {
      console.error('Error fetching venues:', err);
    }
  };

  const fetchBookings = async () => {
    try {
      const res = await authenticatedFetch(`${API_URL}/api/bookings/my-bookings`);
      if (res.ok) {
        const data = await res.json();
        setMyBookings(data);
      }
    } catch (err) {
      console.error('Error fetching bookings:', err);
    }
  };

  const fetchRevenue = async () => {
    try {
      const res = await authenticatedFetch(`${API_URL}/api/bookings/revenue`);
      if (res.ok) {
        const data = await res.json();
        setRevenueStats(data);
      }
    } catch (err) {
      console.error('Error fetching revenue:', err);
    }
  };

  // Auth Handlers
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
    const payload = isRegister ? { email, password, role } : { email, password };

    try {
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Authentication failed');
        return;
      }

      login(data.token, data.user);
      setEmail('');
      setPassword('');
      setBanner({ type: 'success', message: `Welcome back, ${data.user.email}!` });
    } catch (err) {
      setAuthError('Failed to connect to the backend server.');
    }
  };

  // Seat Click handler (tries to acquire Redis hold)
  const handleSeatClick = async (seat: Seat) => {
    if (!user) {
      setBanner({ type: 'warning', message: 'You must log in to reserve seats!' });
      return;
    }

    if (user.role !== 'customer') {
      setBanner({ type: 'warning', message: 'Only customer accounts can book seats.' });
      return;
    }

    if (seat.status === 'booked') return;

    // Release current hold if clicking a different seat
    if (selectedSeat && selectedSeat.id !== seat.id && selectedSeat.status === 'held' && selectedSeat.heldBy === user.id) {
      await authenticatedFetch(`${API_URL}/api/seats/release`, {
        method: 'POST',
        body: JSON.stringify({ eventId: selectedEvent?.id, seatId: selectedSeat.id }),
      });
      setHoldTimer(0);
      setSelectedSeat(null);
    }

    // Toggle release if clicking own held seat
    if (selectedSeat && selectedSeat.id === seat.id && seat.heldBy === user.id) {
      const res = await authenticatedFetch(`${API_URL}/api/seats/release`, {
        method: 'POST',
        body: JSON.stringify({ eventId: selectedEvent?.id, seatId: seat.id }),
      });
      if (res.ok) {
        setHoldTimer(0);
        setSelectedSeat(null);
        setBanner({ type: 'info', message: 'Seat hold released.' });
      }
      return;
    }

    // If held by someone else, ignore
    if (seat.status === 'held' || seat.status === 'offered') {
      setBanner({ type: 'warning', message: 'This seat is already held or offered to another user!' });
      return;
    }

    // Try to hold
    try {
      const res = await authenticatedFetch(`${API_URL}/api/seats/hold`, {
        method: 'POST',
        body: JSON.stringify({ eventId: selectedEvent?.id, seatId: seat.id }),
      });

      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'warning', message: data.error || 'Failed to acquire hold.' });
        return;
      }

      setSelectedSeat({
        ...seat,
        status: 'held',
        heldBy: user.id,
      });
      setHoldTimer(600); // 10 minutes
      setBanner({ type: 'success', message: 'Seat held! Complete checkout in 10 minutes.' });
    } catch (err) {
      console.error('Error holding seat:', err);
    }
  };

  // Confirm booking (checkout)
  const handleCheckout = async () => {
    if (!selectedEvent || !selectedSeat) return;

    try {
      const res = await authenticatedFetch(`${API_URL}/api/bookings/checkout`, {
        method: 'POST',
        body: JSON.stringify({ eventId: selectedEvent.id, seatId: selectedSeat.id }),
      });

      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'warning', message: data.error || 'Booking checkout failed.' });
        return;
      }

      setHoldTimer(0);
      setSelectedSeat(null);
      setBanner({ type: 'success', message: 'Booking confirmed! Ticket QR sent to your email.' });
      fetchBookings();
    } catch (err) {
      console.error('Checkout error:', err);
    }
  };

  // Join Waitlist
  const handleJoinWaitlist = async (category: string) => {
    if (!selectedEvent) return;

    try {
      const res = await authenticatedFetch(`${API_URL}/api/seats/waitlist`, {
        method: 'POST',
        body: JSON.stringify({ eventId: selectedEvent.id, category }),
      });

      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'warning', message: data.error || 'Could not join waitlist.' });
        return;
      }

      setBanner({ 
        type: 'success', 
        message: `Successfully joined waitlist for ${category} seats! You will be notified via email when a seat opens.` 
      });
    } catch (err) {
      console.error('Error joining waitlist:', err);
    }
  };

  // Confirm Waitlist Promotion Offer
  const handleConfirmPromotion = async () => {
    if (!promotionToken) return;

    try {
      const res = await fetch(`${API_URL}/api/seats/waitlist/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: promotionToken }),
      });

      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'warning', message: data.error || 'Failed to claim waitlist offer.' });
        setPromotionToken(null);
        return;
      }

      setPromotionToken(null);
      setBanner({ 
        type: 'success', 
        message: 'Successfully claimed waitlist offer! Your booking is locked. Ticket sent to your email.' 
      });
      fetchBookings();
      setActiveTab('bookings');
    } catch (err) {
      console.error('Error claiming waitlist offer:', err);
    }
  };

  // Cancel Booking
  const handleCancelBooking = async (bookingId: number) => {
    if (!window.confirm('Are you sure you want to cancel this booking? This will trigger waitlist promotions.')) return;

    try {
      const res = await authenticatedFetch(`${API_URL}/api/bookings/cancel/${bookingId}`, {
        method: 'POST',
      });

      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'warning', message: data.error || 'Failed to cancel booking.' });
        return;
      }

      setBanner({ type: 'success', message: 'Booking cancelled. Waitlist processed successfully!' });
      fetchBookings();
      if (selectedEvent) {
        // Reload seat map if currently viewing
        loadSeatLayout(selectedEvent.id);
      }
    } catch (err) {
      console.error('Error cancelling booking:', err);
    }
  };

  // Admin: Create Venue
  const handleCreateVenue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!venueName) return;

    // Parse categories
    const categoriesMap: Record<string, string> = { default: 'Standard' };
    vipRows.split(',').forEach(r => {
      const trimmed = r.trim().toUpperCase();
      if (trimmed) categoriesMap[trimmed] = 'VIP';
    });
    premiumRows.split(',').forEach(r => {
      const trimmed = r.trim().toUpperCase();
      if (trimmed) categoriesMap[trimmed] = 'Premium';
    });

    try {
      const res = await authenticatedFetch(`${API_URL}/api/venues`, {
        method: 'POST',
        body: JSON.stringify({
          name: venueName,
          rowsCount: venueRows,
          colsCount: venueCols,
          rowCategories: categoriesMap,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'warning', message: data.error || 'Failed to create venue.' });
        return;
      }

      setGeneratedVenuePreview({
        name: venueName,
        rows: venueRows,
        cols: venueCols,
        vip: vipRows.split(',').map(s => s.trim().toUpperCase()),
        premium: premiumRows.split(',').map(s => s.trim().toUpperCase()),
      });
      setVenueName('');
      setBanner({ type: 'success', message: 'Venue and seat layout configured!' });
      fetchVenues();
    } catch (err) {
      console.error('Error creating venue:', err);
    }
  };

  // Organiser: Create Event
  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventName || !selectedVenueId || !eventDate || !eventTime) {
      setBanner({ type: 'warning', message: 'All fields are required to create an event.' });
      return;
    }

    try {
      const res = await authenticatedFetch(`${API_URL}/api/events`, {
        method: 'POST',
        body: JSON.stringify({
          name: eventName,
          venueId: selectedVenueId,
          eventDate,
          eventTime,
          pricing: {
            VIP: priceVip,
            Premium: pricePremium,
            Standard: priceStandard,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'warning', message: data.error || 'Failed to create event.' });
        return;
      }

      setEventName('');
      setEventDate('');
      setEventTime('');
      setBanner({ type: 'success', message: 'Event successfully published!' });
      fetchEvents();
      fetchRevenue();
    } catch (err) {
      console.error('Error creating event:', err);
    }
  };

  const loadSeatLayout = async (eventId: number) => {
    try {
      const res = await fetch(`${API_URL}/api/seats/layout?eventId=${eventId}`);
      if (res.ok) {
        const data = await res.json();
        setSeats(data.seats);
      }
    } catch (err) {
      console.error('Error fetching seat layout:', err);
    }
  };

  const selectEventForBooking = (event: Event) => {
    setSelectedEvent(event);
    loadSeatLayout(event.id);
    setSelectedSeat(null);
    setHoldTimer(0);
  };

  // Group seats by row
  const seatsByRow = seats.reduce((acc, seat) => {
    if (!acc[seat.row_name]) {
      acc[seat.row_name] = [];
    }
    acc[seat.row_name].push(seat);
    return acc;
  }, {} as Record<string, Seat[]>);

  // Format countdown timer (MM:SS)
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <h3 style={{ fontFamily: 'var(--font-heading)' }}>Loading application session...</h3>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden' }}>
      <div className="bg-orb orb-1"></div>
      <div className="bg-orb orb-2"></div>
      <div className="bg-orb orb-3"></div>
      {/* Navbar */}
      <nav className="navbar">
        <div className="nav-logo">
          <Ticket size={28} />
          <span>NeoSeat Ticket</span>
        </div>
        <div className="nav-links">
          {user ? (
            <div className="nav-user">
              <span className={`role-badge role-${user.role}`}>{user.role}</span>
              <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{user.email}</span>
              <button className="btn btn-secondary" onClick={logout} style={{ padding: '8px 12px' }}>
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Welcome, Guest</span>
          )}
        </div>
      </nav>

      {/* Main Body */}
      <main style={{ maxWidth: '1200px', margin: '40px auto', padding: '0 20px' }}>
        {/* Banner notification */}
        {banner && (
          <div className={`banner banner-${banner.type === 'warning' ? 'warning' : banner.type === 'success' ? 'success' : ''}`}>
            {banner.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            <span style={{ flexGrow: 1 }}>{banner.message}</span>
            <button style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setBanner(null)}>✕</button>
          </div>
        )}

        {/* Promotion Offer Banner */}
        {promotionToken && (
          <div className="banner banner-warning" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Clock className="animate-pulse" size={24} />
              <strong style={{ fontSize: '18px' }}>Active Waitlist Seat Offer!</strong>
            </div>
            <p>You have been promoted from the waitlist. Click below to claim and confirm your booking. This offer will expire in 15 minutes.</p>
            <button className="btn btn-primary" onClick={handleConfirmPromotion} style={{ padding: '10px 20px', fontSize: '14px' }}>
              Confirm Waitlist Booking
            </button>
          </div>
        )}

        {user ? (
          <div>
            {/* Navigation Tabs based on Role */}
            <div className="tabs-container">
              <button 
                className={`tab-btn ${activeTab === 'events' ? 'active' : ''}`}
                onClick={() => { setActiveTab('events'); setSelectedEvent(null); }}
              >
                Browse Events
              </button>
              
              {user.role === 'customer' && (
                <button 
                  className={`tab-btn ${activeTab === 'bookings' ? 'active' : ''}`}
                  onClick={() => { setActiveTab('bookings'); fetchBookings(); }}
                >
                  My Tickets
                </button>
              )}

              {user.role === 'organiser' && (
                <button 
                  className={`tab-btn ${activeTab === 'organiser' ? 'active' : ''}`}
                  onClick={() => { setActiveTab('organiser'); fetchVenues(); fetchRevenue(); }}
                >
                  Organiser Dashboard
                </button>
              )}

              {user.role === 'admin' && (
                <button 
                  className={`tab-btn ${activeTab === 'admin' ? 'active' : ''}`}
                  onClick={() => setActiveTab('admin')}
                >
                  Admin Panels
                </button>
              )}
            </div>

            {/* TAB CONTENTS */}

            {/* TAB: Browse Events */}
            {activeTab === 'events' && (
              <div>
                {!selectedEvent ? (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
                      <h2 style={{ fontSize: '28px' }}>Upcoming Concerts & Events</h2>
                      <input 
                        type="text" 
                        className="form-control" 
                        style={{ maxWidth: '300px', margin: 0 }}
                        placeholder="🔍 Filter by event or venue..." 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <div className="event-grid">
                      {events
                        .filter(e => 
                          e.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          e.venue_name.toLowerCase().includes(searchQuery.toLowerCase())
                        )
                        .map((event) => (
                        <div key={event.id} className="glass-panel event-card">
                          <h3 style={{ fontSize: '20px', color: '#818cf8', marginBottom: '10px' }}>{event.name}</h3>
                          <p style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '6px' }}>
                            <Calendar size={16} />
                            {new Date(event.event_date).toLocaleDateString()} at {event.event_time}
                          </p>
                          <p style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '15px' }}>
                            <MapPin size={16} />
                            {event.venue_name}
                          </p>
                          
                          <div className="event-details">
                            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '15px' }}>
                              <span className="role-badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>VIP: ${event.pricing.VIP || 0}</span>
                              <span className="role-badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>Premium: ${event.pricing.Premium || 0}</span>
                              <span className="role-badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>Standard: ${event.pricing.Standard || 0}</span>
                            </div>
                            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => selectEventForBooking(event)}>
                              Book Seats
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <button className="btn btn-secondary" onClick={() => setSelectedEvent(null)} style={{ marginBottom: '20px' }}>
                      ← Back to Events
                    </button>
                    
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 350px', gap: '30px', alignItems: 'start' }}>
                      
                      {/* Seat Map Grid */}
                      <div className="seat-map-wrapper">
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                          <h2 style={{ fontSize: '24px' }}>{selectedEvent.name} Seat Grid</h2>
                          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Real-time updates enabled via WebSockets</p>
                        </div>

                        <div className="screen-indicator">
                          <div className="screen-text">Stage / Screen</div>
                        </div>

                        {/* Legends */}
                        <div className="legend-container">
                          <div className="legend-item">
                            <div className="legend-dot" style={{ background: 'rgba(16, 185, 129, 0.15)', border: '1px solid var(--color-available)' }}></div>
                            <span>Available</span>
                          </div>
                          <div className="legend-item">
                            <div className="legend-dot" style={{ background: '#f59e0b' }}></div>
                            <span>My Reservation</span>
                          </div>
                          <div className="legend-item">
                            <div className="legend-dot" style={{ background: 'rgba(245, 158, 11, 0.25)', border: '1px solid var(--color-held)' }}></div>
                            <span>Held by others</span>
                          </div>
                          <div className="legend-item">
                            <div className="legend-dot" style={{ background: 'rgba(168, 85, 247, 0.25)', border: '1px solid var(--color-offered)' }}></div>
                            <span>Offered / Waitlisted</span>
                          </div>
                          <div className="legend-item">
                            <div className="legend-dot" style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.2)' }}></div>
                            <span>Sold / Booked</span>
                          </div>
                        </div>

                        <div className="seat-grid">
                          {/* Column Number Labels at the top of the grid */}
                          <div className="seat-row" style={{ marginBottom: '10px' }}>
                            <span className="row-label" style={{ opacity: 0 }}></span>
                            {Array.from({ length: Math.max(...seats.map(s => s.col_number), 0) }, (_, i) => i + 1).map((colNum) => (
                              <div key={colNum} className="row-label" style={{ width: '38px', color: 'var(--text-light)', fontSize: '11px' }}>
                                {colNum}
                              </div>
                            ))}
                            <span className="row-label" style={{ opacity: 0 }}></span>
                          </div>

                          {Object.keys(seatsByRow).sort().map((rowName) => (
                            <div key={rowName} className="seat-row">
                              {/* Row Letter label on Left */}
                              <span className="row-label">{rowName}</span>
                              
                              {seatsByRow[rowName].sort((a,b) => a.col_number - b.col_number).map((seat) => {
                                let seatClass = 'seat-available';
                                if (seat.status === 'booked') {
                                  seatClass = 'seat-booked';
                                } else if (seat.status === 'held') {
                                  seatClass = seat.heldBy === user?.id ? 'seat-my-hold' : 'seat-held';
                                } else if (seat.status === 'offered') {
                                  seatClass = seat.heldBy === user?.id ? 'seat-my-offer' : 'seat-offered';
                                }

                                return (
                                  <div 
                                    key={seat.id}
                                    className={`seat-cell ${seatClass} category-${seat.category.replace(/\s+/g, '')}`}
                                    onClick={() => handleSeatClick(seat)}
                                    title={`Row ${seat.row_name}, Seat ${seat.col_number} (${seat.category}) - $${seat.price}`}
                                  >
                                    {seat.col_number}
                                  </div>
                                );
                              })}

                              {/* Row Letter label on Right */}
                              <span className="row-label" style={{ marginLeft: '12px' }}>{rowName}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Right Panel: Booking Actions */}
                      <div className="glass-panel" style={{ height: 'fit-content' }}>
                        <h3 style={{ fontSize: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '20px' }}>
                          Selection Details
                        </h3>

                        {selectedSeat ? (
                          <div>
                            <table style={{ width: '100%', marginBottom: '20px', borderCollapse: 'collapse' }}>
                              <tbody>
                                <tr>
                                  <td style={{ padding: '8px 0', color: 'var(--text-secondary)' }}>Position:</td>
                                  <td style={{ padding: '8px 0', fontWeight: 'bold', textAlign: 'right' }}>Row {selectedSeat.row_name}, Seat {selectedSeat.col_number}</td>
                                </tr>
                                <tr>
                                  <td style={{ padding: '8px 0', color: 'var(--text-secondary)' }}>Category:</td>
                                  <td style={{ padding: '8px 0', fontWeight: 'bold', textAlign: 'right' }}>
                                    <span className="role-badge" style={{ background: 'rgba(99, 102, 241, 0.1)', color: '#a5b4fc' }}>
                                      {selectedSeat.category}
                                    </span>
                                  </td>
                                </tr>
                                <tr>
                                  <td style={{ padding: '8px 0', color: 'var(--text-secondary)' }}>Price:</td>
                                  <td style={{ padding: '8px 0', fontWeight: '800', textAlign: 'right', color: '#10b981', fontSize: '18px' }}>${selectedSeat.price}</td>
                                </tr>
                              </tbody>
                            </table>

                            <div className="banner banner-warning" style={{ margin: '15px 0', padding: '10px 14px' }}>
                              <Clock size={16} />
                              <span style={{ fontSize: '12px' }}>Lock expires in: <strong>{formatTime(holdTimer)}</strong></span>
                            </div>

                            <button className="btn btn-primary" onClick={handleCheckout} style={{ width: '100%', marginBottom: '10px' }}>
                              Complete Booking
                            </button>
                            
                            <button 
                              className="btn btn-secondary" 
                              onClick={() => handleSeatClick(selectedSeat)}
                              style={{ width: '100%' }}
                            >
                              Release Seat Lock
                            </button>
                          </div>
                        ) : (
                          <div>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '24px', textAlign: 'center' }}>
                              Select an available seat on the grid to reserve it.
                            </p>
                            
                            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
                              <h4 style={{ fontSize: '16px', marginBottom: '12px' }}>Category Sold Out? Join Waitlist:</h4>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <button className="btn btn-secondary" onClick={() => handleJoinWaitlist('VIP')} style={{ fontSize: '13px', justifyContent: 'space-between' }}>
                                  <span>Join VIP Waitlist</span>
                                  <span style={{ opacity: 0.6 }}>→</span>
                                </button>
                                <button className="btn btn-secondary" onClick={() => handleJoinWaitlist('Premium')} style={{ fontSize: '13px', justifyContent: 'space-between' }}>
                                  <span>Join Premium Waitlist</span>
                                  <span style={{ opacity: 0.6 }}>→</span>
                                </button>
                                <button className="btn btn-secondary" onClick={() => handleJoinWaitlist('Standard')} style={{ fontSize: '13px', justifyContent: 'space-between' }}>
                                  <span>Join Standard Waitlist</span>
                                  <span style={{ opacity: 0.6 }}>→</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB: My Bookings */}
            {activeTab === 'bookings' && (
              <div>
                <h2 style={{ fontSize: '28px', marginBottom: '20px' }}>Your Purchased Tickets</h2>
                {myBookings.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)' }}>You do not have any bookings yet.</p>
                ) : (
                  <div className="tickets-grid">
                    {myBookings.map((booking) => (
                      <div key={booking.id} className="ticket-card">
                        <div className="ticket-header">
                          <h3 style={{ fontSize: '18px', color: booking.status === 'cancelled' ? 'var(--text-muted)' : '#818cf8' }}>
                            {booking.event_name}
                          </h3>
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                            {new Date(booking.event_date).toLocaleDateString()} at {booking.event_time}
                          </span>
                        </div>
                        <div className="ticket-body">
                          <div style={{ width: '100%', marginBottom: '15px', fontSize: '13px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                              <span style={{ color: 'var(--text-secondary)' }}>Venue:</span>
                              <strong>{booking.venue_name}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                              <span style={{ color: 'var(--text-secondary)' }}>Seat:</span>
                              <strong>Row {booking.row_name}, Seat {booking.col_number} ({booking.category})</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                              <span style={{ color: 'var(--text-secondary)' }}>Reference:</span>
                              <code>{booking.booking_reference}</code>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                              <span style={{ color: 'var(--text-secondary)' }}>Paid:</span>
                              <strong>${booking.price_paid}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: 'var(--text-secondary)' }}>Status:</span>
                              <strong style={{ color: booking.status === 'booked' ? '#10b981' : '#ef4444', textTransform: 'uppercase' }}>
                                {booking.status}
                              </strong>
                            </div>
                          </div>

                          {booking.status === 'booked' ? (
                            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                              <div className="qr-placeholder">
                                <img 
                                  src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${booking.booking_reference}`} 
                                  alt="Ticket QR Code" 
                                  className="qr-image"
                                />
                              </div>
                              <button 
                                className="btn btn-danger" 
                                style={{ width: '100%', padding: '8px 12px', fontSize: '13px' }}
                                onClick={() => handleCancelBooking(booking.id)}
                              >
                                Cancel Ticket
                              </button>
                            </div>
                          ) : (
                            <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '10px' }}>
                              Ticket cancelled. Waitlist offered.
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB: Organiser Dashboard */}
            {activeTab === 'organiser' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '30px' }}>
                  
                  {/* Left: Revenue stats table */}
                  <div>
                    <h2 style={{ fontSize: '24px', marginBottom: '20px' }}>Event Sales & Revenue</h2>
                    
                    {revenueStats.length === 0 ? (
                      <p style={{ color: 'var(--text-secondary)' }}>No statistics available. Publish events to track sales.</p>
                    ) : (
                      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                          <thead>
                            <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-color)' }}>
                              <th style={{ padding: '16px 20px', color: 'var(--text-secondary)', fontSize: '13px' }}>Event Name</th>
                              <th style={{ padding: '16px 20px', color: 'var(--text-secondary)', fontSize: '13px' }}>Date</th>
                              <th style={{ padding: '16px 20px', color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center' }}>Sold Tickets</th>
                              <th style={{ padding: '16px 20px', color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'right' }}>Total Revenue</th>
                            </tr>
                          </thead>
                          <tbody>
                            {revenueStats.map((stat) => (
                              <tr key={stat.event_id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                <td style={{ padding: '16px 20px', fontWeight: 'bold' }}>{stat.event_name}</td>
                                <td style={{ padding: '16px 20px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                                  {new Date(stat.event_date).toLocaleDateString()}
                                </td>
                                <td style={{ padding: '16px 20px', textAlign: 'center', fontWeight: '500' }}>
                                  {stat.total_bookings}
                                </td>
                                <td style={{ padding: '16px 20px', textAlign: 'right', fontWeight: '800', color: '#10b981' }}>
                                  ${stat.total_revenue}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Right: Publish Event Form */}
                  <div className="glass-panel">
                    <h3 style={{ fontSize: '20px', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
                      Publish Event
                    </h3>
                    
                    {venues.length === 0 ? (
                      <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                        No venues configured yet. Ask Admin to create a venue first.
                      </p>
                    ) : (
                      <form onSubmit={handleCreateEvent}>
                        <div className="form-group">
                          <label>Event Name</label>
                          <input 
                            type="text" 
                            className="form-control" 
                            value={eventName}
                            onChange={(e) => setEventName(e.target.value)}
                            placeholder="e.g. Coldplay Live 2026"
                          />
                        </div>
                        <div className="form-group">
                          <label>Venue Location</label>
                          <select 
                            className="form-control" 
                            value={selectedVenueId}
                            onChange={(e) => setSelectedVenueId(parseInt(e.target.value, 10))}
                          >
                            {venues.map(v => (
                              <option key={v.id} value={v.id}>{v.name} ({v.rows_count}x{v.cols_count} grid)</option>
                            ))}
                          </select>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                          <div className="form-group">
                            <label>Date</label>
                            <input 
                              type="date" 
                              className="form-control" 
                              value={eventDate}
                              onChange={(e) => setEventDate(e.target.value)}
                            />
                          </div>
                          <div className="form-group">
                            <label>Time</label>
                            <input 
                              type="time" 
                              className="form-control" 
                              value={eventTime}
                              onChange={(e) => setEventTime(e.target.value)}
                            />
                          </div>
                        </div>

                        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '15px', marginTop: '10px' }}>
                          <h4 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '10px' }}>Category Pricing ($)</h4>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                            <div className="form-group">
                              <label>VIP</label>
                              <input 
                                type="number" 
                                className="form-control" 
                                value={priceVip}
                                onChange={(e) => setPriceVip(parseInt(e.target.value, 10))}
                              />
                            </div>
                            <div className="form-group">
                              <label>Premium</label>
                              <input 
                                type="number" 
                                className="form-control" 
                                value={pricePremium}
                                onChange={(e) => setPricePremium(parseInt(e.target.value, 10))}
                              />
                            </div>
                            <div className="form-group">
                              <label>Standard</label>
                              <input 
                                type="number" 
                                className="form-control" 
                                value={priceStandard}
                                onChange={(e) => setPriceStandard(parseInt(e.target.value, 10))}
                              />
                            </div>
                          </div>
                        </div>

                        <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '10px' }}>
                          Publish Event
                        </button>
                      </form>
                    )}
                  </div>

                </div>
              </div>
            )}

            {/* TAB: Admin Panels */}
            {activeTab === 'admin' && (
              <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                <div className="glass-panel">
                  <h2 style={{ fontSize: '24px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Shield size={24} style={{ color: '#ef4444' }} />
                    Create Venue & Seat Grid
                  </h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '24px' }}>
                    Define the grid size and specify VIP/Premium rows. The system will auto-generate coordinate layout seats.
                  </p>

                  <form onSubmit={handleCreateVenue}>
                    <div className="form-group">
                      <label>Venue Name</label>
                      <input 
                        type="text" 
                        className="form-control" 
                        value={venueName}
                        onChange={(e) => setVenueName(e.target.value)}
                        placeholder="e.g. Madison Square Garden"
                      />
                    </div>
                    
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                      <div className="form-group">
                        <label>Rows Count (A-Z)</label>
                        <input 
                          type="number" 
                          className="form-control" 
                          value={venueRows}
                          onChange={(e) => setVenueRows(parseInt(e.target.value, 10))}
                          min={1}
                          max={26}
                        />
                      </div>
                      <div className="form-group">
                        <label>Columns Count (1-30)</label>
                        <input 
                          type="number" 
                          className="form-control" 
                          value={venueCols}
                          onChange={(e) => setVenueCols(parseInt(e.target.value, 10))}
                          min={1}
                          max={30}
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label>VIP Rows (comma separated letters)</label>
                      <input 
                        type="text" 
                        className="form-control" 
                        value={vipRows}
                        onChange={(e) => setVipRows(e.target.value)}
                        placeholder="A,B"
                      />
                    </div>

                    <div className="form-group">
                      <label>Premium Rows (comma separated letters)</label>
                      <input 
                        type="text" 
                        className="form-control" 
                        value={premiumRows}
                        onChange={(e) => setPremiumRows(e.target.value)}
                        placeholder="C,D"
                      />
                    </div>

                    <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                      <strong>Note:</strong> All other rows not listed in VIP or Premium categories will default to <em>Standard</em> seats.
                    </div>

                    <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                      Generate Venue Grid
                    </button>
                  </form>
                </div>

                {generatedVenuePreview && (
                  <div className="glass-panel" style={{ marginTop: '25px', textAlign: 'center' }}>
                    <h3 style={{ fontSize: '18px', marginBottom: '15px', color: 'var(--primary)' }}>
                      Venue Layout Preview: {generatedVenuePreview.name}
                    </h3>
                    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '8px', padding: '20px', background: 'rgba(0,0,0,0.01)', borderRadius: '12px', border: '1px solid var(--border-color)', width: '100%', overflowX: 'auto' }}>
                      {Array.from({ length: generatedVenuePreview.rows }).map((_, r) => {
                        const rowLetter = String.fromCharCode(65 + r);
                        const isVip = generatedVenuePreview.vip.includes(rowLetter);
                        const isPremium = generatedVenuePreview.premium.includes(rowLetter);
                        const categoryClass = isVip ? 'category-VIP' : isPremium ? 'category-Premium' : 'category-Standard';
                        
                        return (
                          <div key={rowLetter} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                            <span style={{ width: '20px', fontSize: '12px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>{rowLetter}</span>
                            {Array.from({ length: generatedVenuePreview.cols }).map((_, c) => (
                              <div 
                                key={c} 
                                className={`seat-cell seat-available ${categoryClass}`}
                                style={{ width: '30px', height: '30px', fontSize: '9px', cursor: 'default' }}
                              >
                                {c + 1}
                              </div>
                            ))}
                            <span style={{ width: '20px', fontSize: '12px', fontWeight: 'bold', color: 'var(--text-secondary)', marginLeft: '6px' }}>{rowLetter}</span>
                          </div>
                        );
                      })}
                    </div>
                    <button 
                      type="button"
                      className="btn btn-secondary" 
                      style={{ marginTop: '20px', display: 'block', margin: '20px auto 0' }}
                      onClick={() => setGeneratedVenuePreview(null)}
                    >
                      Clear Preview
                    </button>
                  </div>
                )}

              </div>
            )}

          </div>
        ) : (
          /* Login/Register Panel Centered in Viewport */
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '70vh', padding: '20px 0' }}>
            <div style={{ maxWidth: '450px', width: '100%', margin: '0 auto' }} className="glass-panel">
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <h2 style={{ fontSize: '28px', marginBottom: '8px' }}>{isRegister ? 'Create Account' : 'Welcome Back'}</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                {isRegister ? 'Already have an account?' : 'New to NeoSeat?'}
                <button 
                  style={{ background: 'transparent', border: 'none', color: '#6366f1', marginLeft: '6px', fontWeight: 'bold', cursor: 'pointer' }}
                  onClick={() => { setIsRegister(!isRegister); setAuthError(''); }}
                >
                  {isRegister ? 'Login' : 'Sign Up'}
                </button>
              </p>
            </div>

            {authError && (
              <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', padding: '12px', borderRadius: '8px', fontSize: '14px', marginBottom: '20px' }}>
                {authError}
              </div>
            )}

            <form onSubmit={handleAuth}>
              <div className="form-group">
                <label>Email Address</label>
                <input 
                  type="email" 
                  className="form-control" 
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  required
                />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input 
                  type="password" 
                  className="form-control" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                />
              </div>

              {isRegister && (
                <div className="form-group">
                  <label>Register as Role</label>
                  <select 
                    className="form-control" 
                    value={role} 
                    onChange={(e) => setRole(e.target.value as any)}
                  >
                    <option value="customer">Customer (Purchase & Hold Tickets)</option>
                    <option value="organiser">Event Organiser (Publish Concerts & Revenue)</option>
                    <option value="admin">Administrator (Create Venues Layouts)</option>
                  </select>
                </div>
              )}

              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '10px' }}>
                {isRegister ? 'Register Account' : 'Sign In'}
              </button>
            </form>

            {/* Quick login credentials removed at user request */}
          </div>
        </div>
        )}
      </main>
    </div>
  );
}
