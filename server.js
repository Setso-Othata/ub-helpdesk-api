require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase client (uses service key — server-side only) ─
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Express setup ─────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ── JWT helpers ───────────────────────────────────────────
const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = '8h';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (e) { return null; }
}

// ── Auth middleware ───────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  req.user = payload;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ═════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ═════════════════════════════════════════════════════════

// POST /api/auth/login
// Body: { identifier: "UB23050001" | "ADM001" | email, password: "..." }
app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;

  if (!identifier || !password)
    return res.status(400).json({ error: 'Identifier and password are required' });

  // Look up user by student_id, admin staff_id, or email
  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .or(`student_id.eq.${identifier},email.eq.${identifier}`)
    .eq('is_active', true)
    .limit(1);

  if (error) {
    console.error('DB error:', error);
    return res.status(500).json({ error: 'Database error' });
  }

  const user = users?.[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  // Verify password
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  // Create session record
  const { data: session } = await supabase
    .from('sessions')
    .insert({
      user_id:    user.user_id,
      role:       user.role,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    })
    .select('session_id')
    .single();

  // Sign JWT
  const token = signToken({
    userId:    user.user_id,
    studentId: user.student_id,
    name:      user.full_name,
    role:      user.role,
    sessionId: session?.session_id
  });

  res.json({
    token,
    user: {
      id:   user.student_id || String(user.user_id),
      name: user.full_name,
      role: user.role
    }
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  if (req.user.sessionId) {
    await supabase
      .from('sessions')
      .update({ is_revoked: true })
      .eq('session_id', req.user.sessionId);
  }
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('user_id, student_id, full_name, email, role, department')
    .eq('user_id', req.user.userId)
    .single();

  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ═════════════════════════════════════════════════════════
// REQUESTS ENDPOINTS
// ═════════════════════════════════════════════════════════

// GET /api/requests  (student — their own requests)
app.get('/api/requests', requireAuth, async (req, res) => {
  const { status } = req.query;
  let query = supabase
    .from('requests')
    .select('*')
    .eq('student_id', req.user.userId)
    .order('submitted_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

// POST /api/requests  (student — submit new request)
app.post('/api/requests', requireAuth, async (req, res) => {
  if (req.user.role !== 'student')
    return res.status(403).json({ error: 'Students only' });

  const { request_type, subject, reason, course_code, course_name, credits_requested } = req.body;

  // Generate ref number
  const { count } = await supabase.from('requests').select('*', { count: 'exact', head: true });
  const refNumber = 'REQ' + String((count || 0) + 1).padStart(4, '0');

  const { data, error } = await supabase
    .from('requests')
    .insert({
      ref_number: refNumber,
      student_id: req.user.userId,
      request_type, subject, reason,
      course_code, course_name, credits_requested
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ request: data });
});

// GET /api/admin/requests  (admin — all requests)
app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  const { status, type } = req.query;
  let query = supabase
    .from('requests')
    .select(`*, student:users!requests_student_id_fkey(full_name, student_id, email)`)
    .order('submitted_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (type)   query = query.eq('request_type', type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

// PUT /api/admin/requests/:id  (admin — approve or deny)
app.put('/api/admin/requests/:id', requireAdmin, async (req, res) => {
  const { status, admin_note } = req.body;
  if (!['approved', 'denied'].includes(status))
    return res.status(400).json({ error: 'Status must be approved or denied' });

  const { data, error } = await supabase
    .from('requests')
    .update({
      status,
      admin_note,
      admin_id:    req.user.userId,
      actioned_at: new Date().toISOString(),
      updated_at:  new Date().toISOString()
    })
    .eq('request_id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ request: data });
});

// ═════════════════════════════════════════════════════════
// FAQ ENDPOINTS
// ═════════════════════════════════════════════════════════

// GET /api/faq  (public)
app.get('/api/faq', async (req, res) => {
  const { category } = req.query;
  let query = supabase
    .from('faq_entries')
    .select('faq_id, category, question, answer, source')
    .eq('is_published', true)
    .order('category')
    .order('sort_order')
    .order('created_at');

  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ faqs: data });
});

// GET /api/admin/faq  (admin — includes unpublished)
app.get('/api/admin/faq', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('faq_entries')
    .select('*, creator:users!faq_entries_created_by_fkey(full_name)')
    .order('category').order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ faqs: data });
});

// POST /api/admin/faq
app.post('/api/admin/faq', requireAdmin, async (req, res) => {
  const { category, question, answer } = req.body;
  const { data, error } = await supabase
    .from('faq_entries')
    .insert({ category, question, answer, source: 'admin_added', created_by: req.user.userId })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ faq: data });
});

// PUT /api/admin/faq/:id
app.put('/api/admin/faq/:id', requireAdmin, async (req, res) => {
  const { category, question, answer, is_published } = req.body;
  const { data, error } = await supabase
    .from('faq_entries')
    .update({ category, question, answer, is_published, updated_at: new Date().toISOString() })
    .eq('faq_id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ faq: data });
});

// DELETE /api/admin/faq/:id  (only non-registry entries)
app.delete('/api/admin/faq/:id', requireAdmin, async (req, res) => {
  const { data: faq } = await supabase
    .from('faq_entries').select('source').eq('faq_id', req.params.id).single();
  if (faq?.source === 'registry')
    return res.status(403).json({ error: 'Base registry entries cannot be deleted' });

  const { error } = await supabase.from('faq_entries').delete().eq('faq_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

// ═════════════════════════════════════════════════════════
// FAQ SUBMISSIONS
// ═════════════════════════════════════════════════════════

// POST /api/faq/submit  (student)
app.post('/api/faq/submit', requireAuth, async (req, res) => {
  const { question, rag_answer, rag_score } = req.body;
  const { data, error } = await supabase
    .from('faq_submissions')
    .insert({ student_id: req.user.userId, question, rag_answer, rag_score })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ submission: data });
});

// GET /api/admin/faq/submissions
app.get('/api/admin/faq/submissions', requireAdmin, async (req, res) => {
  const { status } = req.query;
  let query = supabase
    .from('faq_submissions')
    .select(`*, student:users!faq_submissions_student_id_fkey(full_name, student_id)`)
    .order('submitted_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ submissions: data });
});

// PUT /api/admin/faq/submissions/:id  (approve or dismiss)
app.put('/api/admin/faq/submissions/:id', requireAdmin, async (req, res) => {
  const { status, official_answer, category } = req.body;

  const updateData = {
    status,
    admin_id:    req.user.userId,
    actioned_at: new Date().toISOString()
  };

  if (status === 'approved') {
    if (!official_answer || !category)
      return res.status(400).json({ error: 'official_answer and category required for approval' });

    // Get the original question
    const { data: sub } = await supabase
      .from('faq_submissions').select('question').eq('submission_id', req.params.id).single();

    // Create FAQ entry
    const { data: faq } = await supabase
      .from('faq_entries')
      .insert({
        category, question: sub.question, answer: official_answer,
        source: 'student_submission', created_by: req.user.userId,
        submission_id: parseInt(req.params.id)
      })
      .select().single();

    updateData.official_answer = official_answer;
    updateData.category        = category;
    updateData.faq_id          = faq.faq_id;
  }

  const { data, error } = await supabase
    .from('faq_submissions')
    .update(updateData)
    .eq('submission_id', req.params.id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ submission: data });
});

// ═════════════════════════════════════════════════════════
// REPORTS
// ═════════════════════════════════════════════════════════

// GET /api/admin/reports/requests
app.get('/api/admin/reports/requests', requireAdmin, async (req, res) => {
  const { data: requests } = await supabase.from('requests').select('status, request_type');
  const total   = requests.length;
  const pending  = requests.filter(r => r.status === 'pending').length;
  const approved = requests.filter(r => r.status === 'approved').length;
  const denied   = requests.filter(r => r.status === 'denied').length;

  const byType = requests.reduce((acc, r) => {
    acc[r.request_type] = (acc[r.request_type] || 0) + 1; return acc;
  }, {});

  res.json({ total, pending, approved, denied, byType });
});

// GET /api/admin/reports/faq
app.get('/api/admin/reports/faq', requireAdmin, async (req, res) => {
  const { data: faqs }        = await supabase.from('faq_entries').select('category, source');
  const { data: submissions } = await supabase
    .from('faq_submissions')
    .select(`*, student:users!faq_submissions_student_id_fkey(full_name, student_id)`)
    .order('submitted_at', { ascending: false });

  const byCategory = faqs.reduce((acc, f) => {
    acc[f.category] = (acc[f.category] || 0) + 1; return acc;
  }, {});
  const bySource = faqs.reduce((acc, f) => {
    acc[f.source] = (acc[f.source] || 0) + 1; return acc;
  }, {});

  res.json({
    total: faqs.length,
    byCategory, bySource,
    submissions
  });
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nUB Help Desk API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health\n`);
});
