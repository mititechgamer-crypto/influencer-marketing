// Influencer Marketing — main Express app.
// Local: SQLite (zero setup). Production (Vercel + Supabase): Postgres via DATABASE_URL.
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

const db = require('./lib/db');
const { init } = require('./lib/schema');
const { audit, recordLogin, diffInfluencer } = require('./lib/audit');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const isServerless = !!process.env.VERCEL;

// ---- Session secret ----
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) {
    console.error('FATAL: SESSION_SECRET env var is required in production.');
    process.exit(1);
  }
  const SECRET_FILE = path.join(__dirname, '.session-secret');
  if (fs.existsSync(SECRET_FILE)) {
    sessionSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    sessionSecret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, sessionSecret, { mode: 0o600 });
  }
}

// ---- Session store ----
let sessionStore;
if (db.dialect === 'pg') {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({
    pool: db.pool,
    tableName: 'session',
    createTableIfMissing: true
  });
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// behind Vercel / Render / any HTTPS proxy
if (isProd || isServerless) app.set('trust proxy', 1);

app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd || isServerless,
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

// ---- Helpers ----
async function currentUser(req) {
  if (!req.session.userId) return null;
  return db.one('SELECT id, username, role FROM users WHERE id = $1', [req.session.userId]);
}

async function userBrands(userId, role) {
  if (role === 'admin') {
    return db.many('SELECT id, name, slug FROM brands ORDER BY name');
  }
  return db.many(`
    SELECT b.id, b.name, b.slug
    FROM brands b
    JOIN user_brands ub ON ub.brand_id = b.id
    WHERE ub.user_id = $1
    ORDER BY b.name
  `, [userId]);
}

async function canAccessBrand(user, brandId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const row = await db.one('SELECT 1 AS ok FROM user_brands WHERE user_id = $1 AND brand_id = $2', [user.id, brandId]);
  return !!row;
}

function inr(n) {
  const v = Number(n || 0);
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

app.use(async (req, res, next) => {
  try {
    res.locals.user = await currentUser(req);
    res.locals.inr = inr;
    res.locals.flash = req.session.flash || null;
    req.session.flash = null;
    next();
  } catch (e) { next(e); }
});

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.user || res.locals.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'Admin only.' });
  }
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const NOW_FN = () => (db.dialect === 'pg' ? 'NOW()' : 'CURRENT_TIMESTAMP');

// ---- Auth ----
app.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', ah(async (req, res) => {
  const { username, password } = req.body;
  const uname = String(username || '').trim();
  const user = await db.one('SELECT * FROM users WHERE username = $1', [uname]);
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    await recordLogin(req, user || { id: null, username: uname }, false);
    return res.status(401).render('login', { error: 'Invalid username or password.' });
  }
  req.session.userId = user.id;
  await recordLogin(req, user, true);
  res.redirect('/');
}));

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- Dashboard ----
app.get('/', requireAuth, ah(async (req, res) => {
  const user = res.locals.user;
  const brands = await userBrands(user.id, user.role);
  const brandStats = [];
  for (const b of brands) {
    const stats = await db.one(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(pay_agreed), 0) AS agreed,
        COALESCE(SUM(advance_paid), 0) AS advance,
        COALESCE(SUM(CASE WHEN payment_status = 'full' THEN pay_agreed
                          WHEN payment_status = 'advance' THEN advance_paid
                          ELSE 0 END), 0) AS paid
      FROM influencers WHERE brand_id = $1
    `, [b.id]);
    const agreed = Number(stats.agreed || 0);
    const paid = Number(stats.paid || 0);
    brandStats.push({
      ...b,
      total: Number(stats.total || 0),
      agreed,
      advance: Number(stats.advance || 0),
      paid,
      balance: agreed - paid
    });
  }
  res.render('dashboard', { brands: brandStats });
}));

// ---- Account ----
app.get('/account', requireAuth, (req, res) => {
  res.render('account', { error: null, success: null });
});

app.post('/account/password', requireAuth, ah(async (req, res) => {
  const { current, next: newPw, confirm } = req.body;
  const user = await db.one('SELECT password_hash FROM users WHERE id = $1', [res.locals.user.id]);
  if (!bcrypt.compareSync(String(current || ''), user.password_hash)) {
    return res.render('account', { error: 'Current password is wrong.', success: null });
  }
  if (!newPw || newPw.length < 6) {
    return res.render('account', { error: 'New password must be at least 6 characters.', success: null });
  }
  if (newPw !== confirm) {
    return res.render('account', { error: 'New passwords do not match.', success: null });
  }
  const hash = bcrypt.hashSync(newPw, 10);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, res.locals.user.id]);
  await audit(res.locals.user, 'update', 'user', res.locals.user.id, { summary: 'Changed own password' });
  res.render('account', { error: null, success: 'Password updated.' });
}));

// ---- Brand pages ----
app.get('/brand/:slug', requireAuth, ah(async (req, res) => {
  const brand = await db.one('SELECT * FROM brands WHERE slug = $1', [req.params.slug]);
  if (!brand) return res.status(404).render('error', { message: 'Brand not found.' });
  if (!await canAccessBrand(res.locals.user, brand.id)) {
    return res.status(403).render('error', { message: 'You do not have access to this brand.' });
  }
  const q = String(req.query.q || '').trim();
  let influencers;
  if (q) {
    const like = '%' + q + '%';
    influencers = await db.many(`
      SELECT * FROM influencers
      WHERE brand_id = $1
        AND (handle LIKE $2 OR name LIKE $3 OR email LIKE $4 OR contact LIKE $5 OR product LIKE $6)
      ORDER BY timeline_date DESC, created_at DESC
    `, [brand.id, like, like, like, like, like]);
  } else {
    influencers = await db.many(
      'SELECT * FROM influencers WHERE brand_id = $1 ORDER BY timeline_date DESC, created_at DESC',
      [brand.id]
    );
  }
  res.render('brand', { brand, influencers, q });
}));

// ---- Influencer CRUD (admin) ----
app.get('/brand/:slug/new', requireAuth, requireAdmin, ah(async (req, res) => {
  const brand = await db.one('SELECT * FROM brands WHERE slug = $1', [req.params.slug]);
  if (!brand) return res.status(404).render('error', { message: 'Brand not found.' });
  res.render('influencer-form', { brand, influencer: null, error: null });
}));

function parseInfluencerForm(body) {
  const payAgreed = Number(body.pay_agreed || 0) || 0;
  const advancePaid = Number(body.advance_paid || 0) || 0;
  let paymentStatus = String(body.payment_status || 'unpaid');
  if (!['unpaid', 'advance', 'full'].includes(paymentStatus)) paymentStatus = 'unpaid';
  return {
    handle: String(body.handle || '').trim(),
    name: String(body.name || '').trim(),
    contact: String(body.contact || '').trim(),
    email: String(body.email || '').trim(),
    product: String(body.product || '').trim(),
    script: String(body.script || ''),
    deliverables: String(body.deliverables || ''),
    timeline_date: String(body.timeline_date || '').trim() || null,
    pay_agreed: payAgreed,
    advance_paid: advancePaid,
    payment_status: paymentStatus,
    review_submitted: body.review_submitted ? 1 : 0
  };
}

app.post('/brand/:slug/new', requireAuth, requireAdmin, ah(async (req, res) => {
  const brand = await db.one('SELECT * FROM brands WHERE slug = $1', [req.params.slug]);
  if (!brand) return res.status(404).render('error', { message: 'Brand not found.' });
  const data = parseInfluencerForm(req.body);
  if (!data.handle || !data.name) {
    return res.render('influencer-form', { brand, influencer: data, error: 'Handle and Name are required.' });
  }
  const me = res.locals.user;
  const result = await db.query(`
    INSERT INTO influencers (brand_id, handle, name, contact, email, product, script, deliverables,
      timeline_date, pay_agreed, advance_paid, payment_status, review_submitted,
      updated_by_id, updated_by_username)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id
  `, [brand.id, data.handle, data.name, data.contact, data.email, data.product, data.script,
      data.deliverables, data.timeline_date, data.pay_agreed, data.advance_paid,
      data.payment_status, data.review_submitted, me.id, me.username]);
  const newId = result.rows[0] ? result.rows[0].id : result.lastInsertRowid;
  await audit(me, 'create', 'influencer', newId, {
    brandId: brand.id,
    summary: `Created ${data.handle} (${data.name})`,
    changes: data
  });
  flash(req, 'success', 'Influencer added.');
  res.redirect(`/influencer/${newId}`);
}));

app.get('/influencer/:id', requireAuth, ah(async (req, res) => {
  const inf = await db.one('SELECT * FROM influencers WHERE id = $1', [req.params.id]);
  if (!inf) return res.status(404).render('error', { message: 'Influencer not found.' });
  if (!await canAccessBrand(res.locals.user, inf.brand_id)) {
    return res.status(403).render('error', { message: 'No access to this record.' });
  }
  const brand = await db.one('SELECT * FROM brands WHERE id = $1', [inf.brand_id]);
  res.render('influencer-detail', { brand, influencer: inf });
}));

app.get('/influencer/:id/edit', requireAuth, requireAdmin, ah(async (req, res) => {
  const inf = await db.one('SELECT * FROM influencers WHERE id = $1', [req.params.id]);
  if (!inf) return res.status(404).render('error', { message: 'Influencer not found.' });
  const brand = await db.one('SELECT * FROM brands WHERE id = $1', [inf.brand_id]);
  res.render('influencer-form', { brand, influencer: inf, error: null });
}));

app.post('/influencer/:id/edit', requireAuth, requireAdmin, ah(async (req, res) => {
  const inf = await db.one('SELECT * FROM influencers WHERE id = $1', [req.params.id]);
  if (!inf) return res.status(404).render('error', { message: 'Influencer not found.' });
  const brand = await db.one('SELECT * FROM brands WHERE id = $1', [inf.brand_id]);
  const data = parseInfluencerForm(req.body);
  if (!data.handle || !data.name) {
    return res.render('influencer-form', { brand, influencer: { ...inf, ...data }, error: 'Handle and Name are required.' });
  }
  const me = res.locals.user;
  await db.query(`
    UPDATE influencers SET handle=$1, name=$2, contact=$3, email=$4, product=$5, script=$6, deliverables=$7,
      timeline_date=$8, pay_agreed=$9, advance_paid=$10, payment_status=$11, review_submitted=$12,
      updated_by_id=$13, updated_by_username=$14, updated_at=${NOW_FN()}
    WHERE id = $15
  `, [data.handle, data.name, data.contact, data.email, data.product, data.script, data.deliverables,
      data.timeline_date, data.pay_agreed, data.advance_paid, data.payment_status, data.review_submitted,
      me.id, me.username, inf.id]);
  const changes = diffInfluencer(inf, data);
  if (changes) {
    await audit(me, 'update', 'influencer', inf.id, {
      brandId: inf.brand_id,
      summary: `Updated ${inf.handle} (${inf.name})`,
      changes
    });
  }
  flash(req, 'success', 'Saved.');
  res.redirect(`/influencer/${inf.id}`);
}));

app.post('/influencer/:id/delete', requireAuth, requireAdmin, ah(async (req, res) => {
  const inf = await db.one('SELECT * FROM influencers WHERE id = $1', [req.params.id]);
  if (!inf) return res.status(404).render('error', { message: 'Influencer not found.' });
  const brand = await db.one('SELECT slug FROM brands WHERE id = $1', [inf.brand_id]);
  await db.query('DELETE FROM influencers WHERE id = $1', [inf.id]);
  await audit(res.locals.user, 'delete', 'influencer', inf.id, {
    brandId: inf.brand_id,
    summary: `Deleted ${inf.handle} (${inf.name})`
  });
  flash(req, 'success', 'Influencer deleted.');
  res.redirect(`/brand/${brand.slug}`);
}));

app.post('/influencer/:id/toggle-review', requireAuth, requireAdmin, ah(async (req, res) => {
  const inf = await db.one('SELECT id, brand_id, handle, name, review_submitted FROM influencers WHERE id = $1', [req.params.id]);
  if (!inf) return res.status(404).render('error', { message: 'Influencer not found.' });
  const me = res.locals.user;
  const newVal = inf.review_submitted ? 0 : 1;
  await db.query(`
    UPDATE influencers SET review_submitted = $1, updated_by_id=$2, updated_by_username=$3, updated_at=${NOW_FN()}
    WHERE id = $4
  `, [newVal, me.id, me.username, inf.id]);
  await audit(me, 'update', 'influencer', inf.id, {
    brandId: inf.brand_id,
    summary: `Marked review ${newVal ? 'submitted' : 'not submitted'} for ${inf.handle}`,
    changes: { review_submitted: { from: inf.review_submitted, to: newVal } }
  });
  res.redirect(`/influencer/${inf.id}`);
}));

// ---- Reports ----
app.get('/reports', requireAuth, ah(async (req, res) => {
  const user = res.locals.user;
  const brands = await userBrands(user.id, user.role);
  const brandIds = brands.map(b => Number(b.id));
  if (brandIds.length === 0) {
    return res.render('reports', { brands: [], rows: [], period: 'month', brandFilter: 'all', year: new Date().getFullYear(), totals: null });
  }

  const period = ['month', 'quarter', 'year'].includes(req.query.period) ? req.query.period : 'month';
  const brandFilter = req.query.brand && brandIds.includes(Number(req.query.brand)) ? Number(req.query.brand) : 'all';
  const year = Number(req.query.year) || new Date().getFullYear();

  const bucketExpr = db.buckets[period];

  const params = [];
  let n = 1;
  const placeholders = brandIds.map(() => '$' + (n++)).join(',');
  let where = `WHERE brand_id IN (${placeholders})`;
  params.push(...brandIds);
  if (brandFilter !== 'all') {
    where += ` AND brand_id = $${n++}`;
    params.push(brandFilter);
  }
  if (period !== 'year') {
    where += ` AND ${db.buckets.yearOf} = $${n++}`;
    params.push(String(year));
  }

  const rows = await db.many(`
    SELECT
      ${bucketExpr} AS bucket,
      COUNT(*) AS total,
      COALESCE(SUM(pay_agreed), 0) AS agreed,
      COALESCE(SUM(advance_paid), 0) AS advance,
      COALESCE(SUM(CASE WHEN payment_status = 'full' THEN pay_agreed
                        WHEN payment_status = 'advance' THEN advance_paid
                        ELSE 0 END), 0) AS paid,
      COALESCE(SUM(CASE WHEN review_submitted = 1 THEN 1 ELSE 0 END), 0) AS reviews
    FROM influencers
    ${where}
    GROUP BY bucket
    ORDER BY bucket DESC
  `, params);

  const numRows = rows.map(r => ({
    bucket: r.bucket,
    total: Number(r.total),
    agreed: Number(r.agreed),
    advance: Number(r.advance),
    paid: Number(r.paid),
    reviews: Number(r.reviews)
  }));

  const totals = numRows.reduce((t, r) => ({
    total: t.total + r.total,
    agreed: t.agreed + r.agreed,
    advance: t.advance + r.advance,
    paid: t.paid + r.paid,
    reviews: t.reviews + r.reviews
  }), { total: 0, agreed: 0, advance: 0, paid: 0, reviews: 0 });
  totals.balance = totals.agreed - totals.paid;

  res.render('reports', { brands, rows: numRows, period, brandFilter, year, totals });
}));

// ---- Admin user management ----
app.get('/admin/users', requireAuth, requireAdmin, ah(async (req, res) => {
  const users = await db.many('SELECT id, username, role, created_at FROM users ORDER BY role, username');
  const brands = await db.many('SELECT id, name FROM brands ORDER BY name');
  const assignments = await db.many('SELECT user_id, brand_id FROM user_brands');
  const byUser = {};
  for (const a of assignments) {
    (byUser[a.user_id] ||= new Set()).add(Number(a.brand_id));
  }
  res.render('admin-users', { users, brands, byUser, error: null });
}));

app.post('/admin/users/new', requireAuth, requireAdmin, ah(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (!username || password.length < 6) {
    flash(req, 'error', 'Username required, password must be at least 6 chars.');
    return res.redirect('/admin/users');
  }
  const exists = await db.one('SELECT 1 AS ok FROM users WHERE username = $1', [username]);
  if (exists) {
    flash(req, 'error', 'Username already taken.');
    return res.redirect('/admin/users');
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = await db.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [username, hash, role]
  );
  const newId = result.rows[0] ? result.rows[0].id : result.lastInsertRowid;
  const brandIds = [].concat(req.body.brand_ids || []).map(Number).filter(Boolean);
  for (const bid of brandIds) {
    if (db.dialect === 'pg') {
      await db.query('INSERT INTO user_brands (user_id, brand_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [newId, bid]);
    } else {
      await db.query('INSERT OR IGNORE INTO user_brands (user_id, brand_id) VALUES ($1, $2)', [newId, bid]);
    }
  }
  await audit(res.locals.user, 'create', 'user', newId, {
    summary: `Created user "${username}" (${role}) with access to ${brandIds.length} brand(s)`
  });
  flash(req, 'success', `User "${username}" created.`);
  res.redirect('/admin/users');
}));

app.post('/admin/users/:id/brands', requireAuth, requireAdmin, ah(async (req, res) => {
  const uid = Number(req.params.id);
  const target = await db.one('SELECT id, username, role FROM users WHERE id = $1', [uid]);
  if (!target) return res.status(404).render('error', { message: 'User not found.' });
  if (target.role === 'admin') {
    flash(req, 'error', 'Admins already see all brands.');
    return res.redirect('/admin/users');
  }
  const brandIds = [].concat(req.body.brand_ids || []).map(Number).filter(Boolean);
  await db.query('DELETE FROM user_brands WHERE user_id = $1', [uid]);
  for (const bid of brandIds) {
    if (db.dialect === 'pg') {
      await db.query('INSERT INTO user_brands (user_id, brand_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, bid]);
    } else {
      await db.query('INSERT OR IGNORE INTO user_brands (user_id, brand_id) VALUES ($1, $2)', [uid, bid]);
    }
  }
  await audit(res.locals.user, 'update', 'user', uid, {
    summary: `Updated brand access for "${target.username}" (now ${brandIds.length} brand(s))`,
    changes: { brand_ids: brandIds }
  });
  flash(req, 'success', 'Brand access updated.');
  res.redirect('/admin/users');
}));

app.post('/admin/users/:id/reset-password', requireAuth, requireAdmin, ah(async (req, res) => {
  const uid = Number(req.params.id);
  const target = await db.one('SELECT id, username FROM users WHERE id = $1', [uid]);
  if (!target) return res.status(404).render('error', { message: 'User not found.' });
  const password = String(req.body.password || '');
  if (password.length < 6) {
    flash(req, 'error', 'Password must be at least 6 chars.');
    return res.redirect('/admin/users');
  }
  const hash = bcrypt.hashSync(password, 10);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, uid]);
  await audit(res.locals.user, 'update', 'user', uid, {
    summary: `Reset password for "${target.username}"`
  });
  flash(req, 'success', 'Password reset.');
  res.redirect('/admin/users');
}));

app.post('/admin/users/:id/delete', requireAuth, requireAdmin, ah(async (req, res) => {
  const uid = Number(req.params.id);
  if (uid === res.locals.user.id) {
    flash(req, 'error', "You can't delete yourself.");
    return res.redirect('/admin/users');
  }
  const target = await db.one('SELECT username FROM users WHERE id = $1', [uid]);
  await db.query('DELETE FROM users WHERE id = $1', [uid]);
  if (target) {
    await audit(res.locals.user, 'delete', 'user', uid, { summary: `Deleted user "${target.username}"` });
  }
  flash(req, 'success', 'User deleted.');
  res.redirect('/admin/users');
}));

// ---- Admin: activity log ----
app.get('/admin/activity', requireAuth, requireAdmin, ah(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 50;
  const offset = (page - 1) * perPage;
  const filterUser = String(req.query.user || '').trim();
  const filterEntity = String(req.query.entity || '').trim();

  const params = [];
  const conds = [];
  let n = 1;
  if (filterUser) { conds.push(`username = $${n++}`); params.push(filterUser); }
  if (filterEntity && ['influencer', 'user'].includes(filterEntity)) {
    conds.push(`entity_type = $${n++}`); params.push(filterEntity);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db.many(
    `SELECT id, user_id, username, action, entity_type, entity_id, brand_id, summary, changes, created_at
     FROM audit_log ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${n++} OFFSET $${n++}`,
    [...params, perPage, offset]
  );
  // Decode JSON changes for SQLite (stored as text)
  const decoded = rows.map(r => {
    let changes = r.changes;
    if (typeof changes === 'string') {
      try { changes = JSON.parse(changes); } catch { /* keep as string */ }
    }
    return { ...r, changes };
  });
  const totalRow = await db.one(`SELECT COUNT(*) AS c FROM audit_log ${where}`, params);
  const total = Number(totalRow.c);
  const users = await db.many('SELECT DISTINCT username FROM audit_log ORDER BY username');
  res.render('admin-activity', {
    rows: decoded, total, page, perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    filterUser, filterEntity, users
  });
}));

// ---- Admin: login history ----
app.get('/admin/logins', requireAuth, requireAdmin, ah(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 50;
  const offset = (page - 1) * perPage;
  const filterUser = String(req.query.user || '').trim();
  const params = [];
  const conds = [];
  let n = 1;
  if (filterUser) { conds.push(`username = $${n++}`); params.push(filterUser); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await db.many(
    `SELECT id, user_id, username, ip, user_agent, success, created_at
     FROM login_history ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${n++} OFFSET $${n++}`,
    [...params, perPage, offset]
  );
  const totalRow = await db.one(`SELECT COUNT(*) AS c FROM login_history ${where}`, params);
  const total = Number(totalRow.c);
  const users = await db.many('SELECT DISTINCT username FROM login_history ORDER BY username');
  res.render('admin-logins', {
    rows, total, page, perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    filterUser, users
  });
}));

// ---- Health check ----
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- 404 + error handler ----
app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Server error. Please try again.' });
});

// ---- Initialization (memoized so serverless cold starts share it) ----
let _initPromise;
function ensureInitialized() {
  if (!_initPromise) _initPromise = init();
  return _initPromise;
}

// ---- Local boot (Vercel uses api/index.js instead) ----
if (require.main === module) {
  ensureInitialized()
    .then(() => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`\nInfluencer Marketing App running (${db.dialect}, ${isProd ? 'production' : 'development'}).`);
        console.log(`  Local:    http://localhost:${PORT}`);
        if (!isProd) {
          const nets = os.networkInterfaces();
          for (const name of Object.keys(nets)) {
            for (const iface of nets[name] || []) {
              if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`  Network:  http://${iface.address}:${PORT}   (share with people on your WiFi)`);
              }
            }
          }
          console.log(`\nDefault login -> admin / admin123  (change on the Account page after first login)\n`);
        }
      });
    })
    .catch(err => {
      console.error('Startup failed:', err);
      process.exit(1);
    });
}

module.exports = { app, ensureInitialized };
