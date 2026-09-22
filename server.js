const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { getSeats, holdSeats, verifyHold, releaseExpiredHolds } = require("./reservationService");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function ok(res, data, message = "Success") {
  res.json({ success: true, data, message });
}

function fail(res, status, message, errorCode) {
  res.status(status).json({ success: false, data: null, message, errorCode });
}

app.get("/api/health", (_, res) => ok(res, { status: "ok" }));

// ---------------------------------------------------------------------------
// Catalogue: movies (grouped shows), cities, food & beverage menu, coupons
// ---------------------------------------------------------------------------

app.get("/api/cities", (_, res) => {
  const rows = db.prepare("SELECT DISTINCT city FROM shows ORDER BY city").all();
  ok(res, rows.map(r => r.city));
});

app.get("/api/movies", (req, res) => {
  const { city, search, genre, language } = req.query;
  let sql = "SELECT * FROM shows WHERE 1=1";
  const params = [];
  if (city) { sql += " AND city=?"; params.push(city); }
  if (genre) { sql += " AND genre LIKE ?"; params.push(`%${genre}%`); }
  if (language) { sql += " AND language=?"; params.push(language); }
  if (search) { sql += " AND title LIKE ?"; params.push(`%${search}%`); }
  sql += " ORDER BY show_date, show_time";

  const rows = db.prepare(sql).all(...params);
  const byTitle = new Map();
  for (const r of rows) {
    if (!byTitle.has(r.title)) {
      byTitle.set(r.title, {
        title: r.title,
        genre: r.genre,
        language: r.language,
        duration_mins: r.duration_mins,
        censor_rating: r.censor_rating,
        description: r.description,
        poster_gradient: r.poster_gradient,
        rating: r.rating,
        shows: []
      });
    }
    byTitle.get(r.title).shows.push({
      id: r.id, venue: r.venue, screen: r.screen, city: r.city,
      show_date: r.show_date, show_time: r.show_time, format: r.format
    });
  }
  ok(res, Array.from(byTitle.values()));
});

app.get("/api/foods", (_, res) => {
  ok(res, db.prepare("SELECT * FROM foods ORDER BY category, price").all());
});

app.post("/api/coupons/apply", (req, res) => {
  const { code, amount } = req.body;
  if (!code) return fail(res, 400, "Coupon code is required", "COUPON_REQUIRED");

  const coupon = db.prepare("SELECT * FROM coupons WHERE code=?").get(String(code).toUpperCase());
  if (!coupon) return fail(res, 404, "Invalid coupon code", "COUPON_NOT_FOUND");
  if (amount < coupon.min_amount) {
    return fail(res, 400, `This coupon needs a minimum order of ₹${coupon.min_amount}`, "COUPON_MIN_NOT_MET");
  }

  let discount = coupon.type === "PERCENT" ? Math.round(amount * (coupon.value / 100)) : coupon.value;
  if (coupon.max_discount) discount = Math.min(discount, coupon.max_discount);
  discount = Math.min(discount, amount);

  ok(res, { code: coupon.code, discount, description: coupon.description }, "Coupon applied");
});

// ---------------------------------------------------------------------------
// Shows & seat map
// ---------------------------------------------------------------------------

app.get("/api/shows", (_, res) => {
  ok(res, db.prepare("SELECT * FROM shows ORDER BY show_date, show_time").all());
});

app.get("/api/shows/:showId", (req, res) => {
  const show = db.prepare("SELECT * FROM shows WHERE id=?").get(req.params.showId);
  if (!show) return fail(res, 404, "Show not found", "SHOW_NOT_FOUND");
  ok(res, show);
});

app.get("/api/shows/:showId/seats", (req, res) => {
  try {
    const show = db.prepare("SELECT * FROM shows WHERE id=?").get(req.params.showId);
    if (!show) return fail(res, 404, "Show not found", "SHOW_NOT_FOUND");
    ok(res, getSeats(req.params.showId));
  } catch (e) {
    fail(res, 500, e.message, "SERVER_ERROR");
  }
});

app.post("/api/shows/:showId/hold-seats", (req, res) => {
  const { userId, seatIds } = req.body;
  try {
    const result = holdSeats({ showId: req.params.showId, userId: userId || "demo-user", seatIds });
    ok(res, result, "Seats reserved for 10 minutes");
  } catch (e) {
    fail(res, e.code === "SEAT_UNAVAILABLE" ? 409 : 400, e.message, e.code || "HOLD_FAILED");
  }
});

// ---------------------------------------------------------------------------
// Payment (mock) — now supports food add-ons and coupon discounts
// ---------------------------------------------------------------------------

const CONVENIENCE_FEE = 60;

app.post("/api/payments/mock", (req, res) => {
  const {
    showId, userId = "demo-user", seatIds,
    foodItems = [], couponCode, discount = 0,
    paymentResult = "SUCCESS", paymentMethod = "CARD",
    idempotencyKey
  } = req.body;

  if (!idempotencyKey) return fail(res, 400, "idempotencyKey is required", "IDEMPOTENCY_REQUIRED");

  const existing = db.prepare(`
    SELECT b.*, p.id AS payment_id, p.status AS payment_status
    FROM bookings b LEFT JOIN payments p ON p.booking_id=b.id
    WHERE b.idempotency_key=?
  `).get(idempotencyKey);

  if (existing) return ok(res, existing, "Existing idempotent result returned");

  try {
    const seatRows = db.prepare(`
      SELECT id, price FROM seats WHERE id IN (${seatIds.map(() => "?").join(",")})
    `).all(...seatIds);
    const seatAmount = seatRows.reduce((sum, x) => sum + x.price, 0);

    let foodAmount = 0;
    const foodDetails = [];
    if (Array.isArray(foodItems) && foodItems.length) {
      const foodIds = foodItems.map(f => f.id);
      const foodRows = db.prepare(`
        SELECT id, name, price FROM foods WHERE id IN (${foodIds.map(() => "?").join(",")})
      `).all(...foodIds);
      const foodMap = new Map(foodRows.map(f => [f.id, f]));
      for (const item of foodItems) {
        const f = foodMap.get(item.id);
        if (!f) continue;
        const qty = Math.max(1, Number(item.qty) || 1);
        foodAmount += f.price * qty;
        foodDetails.push({ id: f.id, name: f.name, price: f.price, qty });
      }
    }

    const safeDiscount = Math.max(0, Math.min(Number(discount) || 0, seatAmount + foodAmount + CONVENIENCE_FEE));
    const amount = Math.max(0, seatAmount + foodAmount + CONVENIENCE_FEE - safeDiscount);

    const transaction = db.transaction(() => {
      verifyHold({ showId, userId, seatIds });

      const bookingId = "BK-" + crypto.randomUUID().slice(0, 8).toUpperCase();
      const paymentId = "PAY-" + crypto.randomUUID().slice(0, 8).toUpperCase();
      const now = new Date().toISOString();

      const bookingStatus = paymentResult === "SUCCESS" ? "CONFIRMED"
        : paymentResult === "CANCELLED" ? "CANCELLED" : "PAYMENT_FAILED";

      const paymentStatus = paymentResult === "SUCCESS" ? "SUCCESS"
        : paymentResult === "CANCELLED" ? "CANCELLED" : "FAILED";

      db.prepare(`
        INSERT INTO bookings(id,show_id,user_id,status,amount,seat_amount,food_amount,convenience_fee,discount,coupon_code,food_items,idempotency_key,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(bookingId, showId, userId, bookingStatus, amount, seatAmount, foodAmount, CONVENIENCE_FEE, safeDiscount, couponCode || null, JSON.stringify(foodDetails), idempotencyKey, now);

      const insertSeat = db.prepare(`
        INSERT INTO booking_seats(booking_id,show_id,seat_id) VALUES(?,?,?)
      `);
      for (const seatId of seatIds) insertSeat.run(bookingId, showId, seatId);

      db.prepare(`
        INSERT INTO payments(id,booking_id,status,amount,method,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(paymentId, bookingId, paymentStatus, amount, paymentMethod, now);

      db.prepare(`
        UPDATE seat_holds
        SET status='RELEASED'
        WHERE show_id=? AND user_id=? AND status='HELD'
          AND seat_id IN (${seatIds.map(() => "?").join(",")})
      `).run(showId, userId, ...seatIds);

      return { bookingId, paymentId, bookingStatus, paymentStatus, amount, seatAmount, foodAmount, convenienceFee: CONVENIENCE_FEE, discount: safeDiscount };
    });

    ok(res, transaction(), "Mock payment processed");
  } catch (e) {
    const status = e.code === "HOLD_EXPIRED" ? 409 : 400;
    fail(res, status, e.message, e.code || "PAYMENT_FAILED");
  }
});

// ---------------------------------------------------------------------------
// Bookings: lookup, history, cancellation
// ---------------------------------------------------------------------------

app.get("/api/bookings/:id", (req, res) => {
  const booking = db.prepare(`
    SELECT b.*, p.id AS payment_id, p.status AS payment_status, p.method AS payment_method,
           s.title, s.venue, s.screen, s.city, s.show_date, s.show_time, s.format, s.language
    FROM bookings b
    JOIN shows s ON s.id=b.show_id
    LEFT JOIN payments p ON p.booking_id=b.id
    WHERE b.id=?
  `).get(req.params.id);

  if (!booking) return fail(res, 404, "Booking not found", "BOOKING_NOT_FOUND");

  const seats = db.prepare(`
    SELECT seat_id FROM booking_seats WHERE booking_id=?
  `).all(req.params.id).map(x => x.seat_id);

  ok(res, { ...booking, seats, foodItems: JSON.parse(booking.food_items || "[]") });
});

app.get("/api/bookings", (req, res) => {
  const userId = req.query.userId || "demo-user";
  const rows = db.prepare(`
    SELECT b.*, s.title, s.venue, s.city, s.show_date, s.show_time, s.format
    FROM bookings b JOIN shows s ON s.id=b.show_id
    WHERE b.user_id=? ORDER BY b.created_at DESC
  `).all(userId);

  const withSeats = rows.map(b => ({
    ...b,
    seats: db.prepare("SELECT seat_id FROM booking_seats WHERE booking_id=?").all(b.id).map(x => x.seat_id),
    foodItems: JSON.parse(b.food_items || "[]")
  }));

  ok(res, withSeats);
});

app.post("/api/bookings/:id/cancel", (req, res) => {
  const booking = db.prepare(`
    SELECT b.*, s.show_date, s.show_time FROM bookings b
    JOIN shows s ON s.id = b.show_id WHERE b.id=?
  `).get(req.params.id);

  if (!booking) return fail(res, 404, "Booking not found", "BOOKING_NOT_FOUND");
  if (booking.status !== "CONFIRMED") {
    return fail(res, 400, "Only confirmed bookings can be cancelled", "NOT_CANCELLABLE");
  }

  const showStart = new Date(`${booking.show_date}T${booking.show_time}:00`);
  const hoursToShow = (showStart.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursToShow < 2) {
    return fail(res, 400, "Cancellations are only allowed up to 2 hours before showtime", "CANCEL_WINDOW_CLOSED");
  }

  // Simple slab-based refund policy for the mock gateway.
  const refundPercent = hoursToShow >= 24 ? 90 : hoursToShow >= 6 ? 50 : 25;
  const refundAmount = Math.round(booking.amount * (refundPercent / 100));

  db.prepare("UPDATE bookings SET status='CANCELLED' WHERE id=?").run(booking.id);
  db.prepare("UPDATE payments SET status='CANCELLED' WHERE booking_id=?").run(booking.id);

  ok(res, { bookingId: booking.id, refundPercent, refundAmount }, "Booking cancelled");
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

if (require.main === module) {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`SeatLock running at http://localhost:${port}`));
}

module.exports = app;
