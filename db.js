const Database = require("better-sqlite3");
const path = require("path");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "booking.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  venue TEXT NOT NULL,
  screen TEXT NOT NULL,
  city TEXT NOT NULL,
  show_date TEXT NOT NULL,
  show_time TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT 'Drama',
  language TEXT NOT NULL DEFAULT 'English',
  format TEXT NOT NULL DEFAULT '2D',
  duration_mins INTEGER NOT NULL DEFAULT 120,
  censor_rating TEXT NOT NULL DEFAULT 'UA',
  description TEXT NOT NULL DEFAULT '',
  poster_gradient TEXT NOT NULL DEFAULT '135deg,#7c3aed,#db2777',
  rating REAL NOT NULL DEFAULT 4.0
);

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  row_name TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  seat_type TEXT NOT NULL,
  price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seat_holds (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('HELD','RELEASED','EXPIRED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(show_id, seat_id, status),
  FOREIGN KEY(show_id) REFERENCES shows(id),
  FOREIGN KEY(seat_id) REFERENCES seats(id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','PAYMENT_PROCESSING','CONFIRMED','PAYMENT_FAILED','CANCELLED','EXPIRED')),
  amount INTEGER NOT NULL,
  seat_amount INTEGER NOT NULL DEFAULT 0,
  food_amount INTEGER NOT NULL DEFAULT 0,
  convenience_fee INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT,
  food_items TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY(show_id) REFERENCES shows(id)
);

CREATE TABLE IF NOT EXISTS booking_seats (
  booking_id TEXT NOT NULL,
  show_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  PRIMARY KEY(show_id, seat_id),
  FOREIGN KEY(booking_id) REFERENCES bookings(id),
  FOREIGN KEY(show_id) REFERENCES shows(id),
  FOREIGN KEY(seat_id) REFERENCES seats(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('INITIATED','PROCESSING','SUCCESS','FAILED','CANCELLED')),
  amount INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'CARD',
  created_at TEXT NOT NULL,
  FOREIGN KEY(booking_id) REFERENCES bookings(id)
);

CREATE TABLE IF NOT EXISTS foods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price INTEGER NOT NULL,
  veg INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('PERCENT','FLAT')),
  value INTEGER NOT NULL,
  min_amount INTEGER NOT NULL DEFAULT 0,
  max_discount INTEGER,
  description TEXT NOT NULL DEFAULT ''
);
`);

// Lightweight migration for databases created by earlier versions of this schema.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
[
  ["shows", "genre", "TEXT NOT NULL DEFAULT 'Drama'"],
  ["shows", "language", "TEXT NOT NULL DEFAULT 'English'"],
  ["shows", "format", "TEXT NOT NULL DEFAULT '2D'"],
  ["shows", "duration_mins", "INTEGER NOT NULL DEFAULT 120"],
  ["shows", "censor_rating", "TEXT NOT NULL DEFAULT 'UA'"],
  ["shows", "description", "TEXT NOT NULL DEFAULT ''"],
  ["shows", "poster_gradient", "TEXT NOT NULL DEFAULT '135deg,#7c3aed,#db2777'"],
  ["shows", "rating", "REAL NOT NULL DEFAULT 4.0"],
  ["bookings", "seat_amount", "INTEGER NOT NULL DEFAULT 0"],
  ["bookings", "food_amount", "INTEGER NOT NULL DEFAULT 0"],
  ["bookings", "convenience_fee", "INTEGER NOT NULL DEFAULT 0"],
  ["bookings", "discount", "INTEGER NOT NULL DEFAULT 0"],
  ["bookings", "coupon_code", "TEXT"],
  ["bookings", "food_items", "TEXT NOT NULL DEFAULT '[]'"],
  ["payments", "method", "TEXT NOT NULL DEFAULT 'CARD'"]
].forEach(([t, c, d]) => ensureColumn(t, c, d));

function seed() {
  const seatCount = db.prepare("SELECT COUNT(*) AS count FROM seats").get().count;
  if (seatCount === 0) {
    const insertSeat = db.prepare(`
      INSERT INTO seats(id,row_name,seat_number,seat_type,price)
      VALUES(?,?,?,?,?)
    `);
    const rows = ["A", "B", "C", "D", "E", "F", "G", "H"];
    for (const row of rows) {
      for (let n = 1; n <= 10; n++) {
        let type = "REGULAR", price = 220;
        if (row === "A" || row === "B") { type = "RECLINER"; price = 480; }
        else if (row === "C" || row === "D") { type = "PREMIUM"; price = 350; }
        insertSeat.run(`${row}${n}`, row, n, type, price);
      }
    }
  }

  const showCount = db.prepare("SELECT COUNT(*) AS count FROM shows").get().count;
  if (showCount === 0) {
    const insertShow = db.prepare(`
      INSERT INTO shows(id,title,venue,screen,city,show_date,show_time,genre,language,format,duration_mins,censor_rating,description,poster_gradient,rating)
      VALUES(@id,@title,@venue,@screen,@city,@show_date,@show_time,@genre,@language,@format,@duration_mins,@censor_rating,@description,@poster_gradient,@rating)
    `);

    // show-1 / show-2 kept intentionally stable — the concurrency test suite targets these IDs directly.
    const shows = [
      { id: "show-1", title: "Avengers: Secret Wars", venue: "PVR City Mall", screen: "Screen 2", city: "Jaipur", show_date: "2026-09-25", show_time: "19:30", genre: "Action, Sci-Fi", language: "English", format: "IMAX 3D", duration_mins: 168, censor_rating: "UA", description: "The Avengers face their most dangerous threat yet in a battle that spans realities.", poster_gradient: "135deg,#7c3aed,#db2777", rating: 4.6 },
      { id: "show-2", title: "Avengers: Secret Wars", venue: "PVR City Mall", screen: "Screen 2", city: "Jaipur", show_date: "2026-09-25", show_time: "22:15", genre: "Action, Sci-Fi", language: "English", format: "2D", duration_mins: 168, censor_rating: "UA", description: "The Avengers face their most dangerous threat yet in a battle that spans realities.", poster_gradient: "135deg,#7c3aed,#db2777", rating: 4.6 },
      { id: "show-3", title: "Avengers: Secret Wars", venue: "INOX Metro Hub", screen: "Screen 1", city: "Jaipur", show_date: "2026-09-25", show_time: "18:00", genre: "Action, Sci-Fi", language: "Hindi", format: "3D", duration_mins: 168, censor_rating: "UA", description: "The Avengers face their most dangerous threat yet in a battle that spans realities.", poster_gradient: "135deg,#7c3aed,#db2777", rating: 4.6 },
      { id: "show-4", title: "Avengers: Secret Wars", venue: "INOX Metro Hub", screen: "Screen 1", city: "Mumbai", show_date: "2026-09-26", show_time: "20:30", genre: "Action, Sci-Fi", language: "Hindi", format: "IMAX 3D", duration_mins: 168, censor_rating: "UA", description: "The Avengers face their most dangerous threat yet in a battle that spans realities.", poster_gradient: "135deg,#7c3aed,#db2777", rating: 4.6 },
      { id: "show-5", title: "Monsoon Diaries", venue: "PVR City Mall", screen: "Screen 4", city: "Jaipur", show_date: "2026-09-25", show_time: "17:15", genre: "Romance, Drama", language: "Hindi", format: "2D", duration_mins: 132, censor_rating: "U", description: "A gentle love story set against the backdrop of a small hill town's first monsoon.", poster_gradient: "135deg,#0ea5e9,#22c55e", rating: 4.2 },
      { id: "show-6", title: "Monsoon Diaries", venue: "PVR City Mall", screen: "Screen 4", city: "Jaipur", show_date: "2026-09-26", show_time: "21:00", genre: "Romance, Drama", language: "Hindi", format: "2D", duration_mins: 132, censor_rating: "U", description: "A gentle love story set against the backdrop of a small hill town's first monsoon.", poster_gradient: "135deg,#0ea5e9,#22c55e", rating: 4.2 },
      { id: "show-7", title: "Circuit Breaker", venue: "Cinepolis Mansarovar", screen: "Screen 3", city: "Jaipur", show_date: "2026-09-25", show_time: "23:00", genre: "Thriller", language: "English", format: "2D", duration_mins: 118, censor_rating: "A", description: "A cybersecurity analyst has one night to stop a blackout that could kill thousands.", poster_gradient: "135deg,#0f172a,#dc2626", rating: 4.4 },
      { id: "show-8", title: "Circuit Breaker", venue: "Cinepolis Mansarovar", screen: "Screen 3", city: "Bengaluru", show_date: "2026-09-27", show_time: "19:45", genre: "Thriller", language: "English", format: "2D", duration_mins: 118, censor_rating: "A", description: "A cybersecurity analyst has one night to stop a blackout that could kill thousands.", poster_gradient: "135deg,#0f172a,#dc2626", rating: 4.4 },
      { id: "show-9", title: "Laugh Track", venue: "PVR City Mall", screen: "Screen 1", city: "Jaipur", show_date: "2026-09-25", show_time: "15:30", genre: "Comedy", language: "Hindi", format: "2D", duration_mins: 108, censor_rating: "U", description: "A washed-up stand-up comic gets one last shot at a comeback special.", poster_gradient: "135deg,#f59e0b,#ef4444", rating: 3.9 },
      { id: "show-10", title: "Laugh Track", venue: "INOX Metro Hub", screen: "Screen 2", city: "Jaipur", show_date: "2026-09-26", show_time: "16:00", genre: "Comedy", language: "Hindi", format: "2D", duration_mins: 108, censor_rating: "U", description: "A washed-up stand-up comic gets one last shot at a comeback special.", poster_gradient: "135deg,#f59e0b,#ef4444", rating: 3.9 }
    ];
    for (const s of shows) insertShow.run(s);
  }

  const foodCount = db.prepare("SELECT COUNT(*) AS count FROM foods").get().count;
  if (foodCount === 0) {
    const insertFood = db.prepare(`INSERT INTO foods(id,name,category,price,veg) VALUES(?,?,?,?,?)`);
    const foods = [
      ["food-1", "Classic Salted Popcorn (L)", "Popcorn", 260, 1],
      ["food-2", "Caramel Popcorn (L)", "Popcorn", 290, 1],
      ["food-3", "Cheese Popcorn Combo + 2 Cola", "Combo", 480, 1],
      ["food-4", "Nachos with Cheese Dip", "Snacks", 240, 1],
      ["food-5", "Loaded Nachos (Non-Veg)", "Snacks", 310, 0],
      ["food-6", "Cold Coffee", "Beverage", 180, 1],
      ["food-7", "Coca-Cola (500ml)", "Beverage", 130, 1],
      ["food-8", "Veg Puff (Pack of 2)", "Snacks", 150, 1],
      ["food-9", "Chicken Puff (Pack of 2)", "Snacks", 190, 0]
    ];
    for (const f of foods) insertFood.run(...f);
  }

  const couponCount = db.prepare("SELECT COUNT(*) AS count FROM coupons").get().count;
  if (couponCount === 0) {
    const insertCoupon = db.prepare(`
      INSERT INTO coupons(code,type,value,min_amount,max_discount,description)
      VALUES(?,?,?,?,?,?)
    `);
    insertCoupon.run("FIRST50", "FLAT", 50, 200, null, "Flat ₹50 off on your first booking");
    insertCoupon.run("SEAT20", "PERCENT", 20, 500, 200, "20% off, up to ₹200, on bookings above ₹500");
    insertCoupon.run("WEEKEND10", "PERCENT", 10, 0, 100, "10% off, up to ₹100, on any booking");
  }
}

seed();

module.exports = db;
