const bcrypt = require('bcryptjs');
const db = require('./db');

async function ensureSchema() {
  if (db.dialect === 'pg') {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','user')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_brands (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        finance_access SMALLINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, brand_id)
      )
    `);
    await db.query('ALTER TABLE user_brands ADD COLUMN IF NOT EXISTS finance_access SMALLINT NOT NULL DEFAULT 0');
    await db.query(`
      CREATE TABLE IF NOT EXISTS influencers (
        id SERIAL PRIMARY KEY,
        brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        handle TEXT NOT NULL,
        name TEXT NOT NULL,
        contact TEXT,
        email TEXT,
        product TEXT,
        script TEXT,
        deliverables TEXT,
        timeline_date DATE,
        pay_agreed NUMERIC(14,2) NOT NULL DEFAULT 0,
        advance_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','advance','full')),
        review_submitted SMALLINT NOT NULL DEFAULT 0,
        updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by_username TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Migrations for pre-existing installs
    await db.query('ALTER TABLE influencers ADD COLUMN IF NOT EXISTS updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    await db.query('ALTER TABLE influencers ADD COLUMN IF NOT EXISTS updated_by_username TEXT');

    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
        summary TEXT,
        changes JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS login_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        success SMALLINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        founder TEXT NOT NULL,
        spent_date DATE NOT NULL,
        vendor TEXT NOT NULL,
        amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        notes TEXT,
        created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_username TEXT,
        updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by_username TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query('CREATE INDEX IF NOT EXISTS idx_influencers_brand ON influencers(brand_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_influencers_timeline ON influencers(timeline_date)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_login_created ON login_history(created_at DESC)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_login_user ON login_history(user_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_expenses_brand ON expenses(brand_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(spent_date DESC)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_expenses_founder ON expenses(founder)');
  } else {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','user')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS brands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_brands (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        finance_access INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, brand_id)
      )
    `);
    {
      const ubcols = await db.many('PRAGMA table_info(user_brands)');
      if (!ubcols.some(c => c.name === 'finance_access')) {
        await db.query('ALTER TABLE user_brands ADD COLUMN finance_access INTEGER NOT NULL DEFAULT 0');
      }
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS influencers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        handle TEXT NOT NULL,
        name TEXT NOT NULL,
        contact TEXT,
        email TEXT,
        product TEXT,
        script TEXT,
        deliverables TEXT,
        timeline_date TEXT,
        pay_agreed REAL NOT NULL DEFAULT 0,
        advance_paid REAL NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','advance','full')),
        review_submitted INTEGER NOT NULL DEFAULT 0,
        updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by_username TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // SQLite lacks "ADD COLUMN IF NOT EXISTS" — check the pragma first.
    const cols = await db.many('PRAGMA table_info(influencers)');
    const names = new Set(cols.map(c => c.name));
    if (!names.has('updated_by_id')) {
      await db.query('ALTER TABLE influencers ADD COLUMN updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    }
    if (!names.has('updated_by_username')) {
      await db.query('ALTER TABLE influencers ADD COLUMN updated_by_username TEXT');
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
        summary TEXT,
        changes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS login_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        founder TEXT NOT NULL,
        spent_date TEXT NOT NULL,
        vendor TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        notes TEXT,
        created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_username TEXT,
        updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by_username TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query('CREATE INDEX IF NOT EXISTS idx_influencers_brand ON influencers(brand_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_influencers_timeline ON influencers(timeline_date)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_login_created ON login_history(created_at DESC)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_login_user ON login_history(user_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_expenses_brand ON expenses(brand_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(spent_date DESC)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_expenses_founder ON expenses(founder)');
  }
}

async function seed() {
  const brands = [
    { name: 'SimpleObjectz', slug: 'simpleobjectz' },
    { name: 'Vaayuraksh', slug: 'vaayuraksh' },
    { name: 'Mintly Beverages', slug: 'mintly' }
  ];
  for (const b of brands) {
    if (db.dialect === 'pg') {
      await db.query('INSERT INTO brands (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING', [b.name, b.slug]);
    } else {
      await db.query('INSERT OR IGNORE INTO brands (name, slug) VALUES ($1, $2)', [b.name, b.slug]);
    }
  }

  const admin = await db.one('SELECT id FROM users WHERE username = $1', ['admin']);
  if (!admin) {
    const password = process.env.INITIAL_ADMIN_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(password, 10);
    await db.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', ['admin', hash, 'admin']);
    if (process.env.INITIAL_ADMIN_PASSWORD) {
      console.log('Seeded admin user with password from INITIAL_ADMIN_PASSWORD env var.');
    } else {
      console.log('Seeded default admin -> username: admin   password: admin123   (CHANGE IMMEDIATELY)');
    }
  }
}

async function init() {
  await ensureSchema();
  await seed();
}

module.exports = { init };

if (require.main === module) {
  init().then(() => { console.log('DB initialized.'); process.exit(0); })
        .catch(e => { console.error(e); process.exit(1); });
}
