const db = require('./db');

// Fields we diff when an influencer is edited.
const INFLUENCER_FIELDS = [
  'handle', 'name', 'contact', 'email', 'product', 'script', 'deliverables',
  'timeline_date', 'pay_agreed', 'advance_paid', 'payment_status', 'review_submitted'
];

function diffInfluencer(oldRec, newRec) {
  const changes = {};
  for (const f of INFLUENCER_FIELDS) {
    const a = oldRec[f];
    const b = newRec[f];
    const av = a == null ? '' : String(a);
    const bv = b == null ? '' : String(b);
    if (av !== bv) changes[f] = { from: a, to: b };
  }
  return Object.keys(changes).length ? changes : null;
}

async function audit(actor, action, entityType, entityId, opts = {}) {
  if (!actor) return;
  const changes = opts.changes ? (db.dialect === 'pg' ? opts.changes : JSON.stringify(opts.changes)) : null;
  await db.query(`
    INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, brand_id, summary, changes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    actor.id, actor.username, action, entityType, entityId,
    opts.brandId || null, opts.summary || null, changes
  ]);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
    || req.socket?.remoteAddress || null;
}

async function recordLogin(req, user, success = true) {
  const ip = clientIp(req);
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);
  await db.query(`
    INSERT INTO login_history (user_id, username, ip, user_agent, success)
    VALUES ($1, $2, $3, $4, $5)
  `, [user ? user.id : null, user ? user.username : (req.body?.username || 'unknown'), ip, ua, success ? 1 : 0]);
}

module.exports = { audit, recordLogin, diffInfluencer, INFLUENCER_FIELDS };
