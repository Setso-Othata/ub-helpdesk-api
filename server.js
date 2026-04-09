require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const multer     = require('multer');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase client ───────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Express setup ─────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ── Multer — memory storage, 5 MB limit per file ──────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['application/pdf','image/jpeg','image/jpg','image/png'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF, JPG and PNG allowed'));
  }
});

// ── JWT helpers ───────────────────────────────────────────
const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = '8h';
const signToken   = p  => jwt.sign(p, JWT_SECRET, { expiresIn: JWT_EXPIRES });
const verifyToken = t  => { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } };

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

// ═══════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password)
    return res.status(400).json({ error: 'Identifier and password are required' });

  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .or(`student_id.eq.${identifier},email.eq.${identifier}`)
    .eq('is_active', true)
    .limit(1);

  if (error) return res.status(500).json({ error: 'Database error' });
  const user = users?.[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const { data: session } = await supabase
    .from('sessions')
    .insert({
      user_id:    user.user_id,
      role:       user.role,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString()
    })
    .select('session_id')
    .single();

  const token = signToken({
    userId:    user.user_id,
    studentId: user.student_id,
    name:      user.full_name,
    role:      user.role,
    sessionId: session?.session_id
  });

  res.json({
    token,
    user: { id: user.student_id || String(user.user_id), name: user.full_name, role: user.role }
  });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  if (req.user.sessionId) {
    await supabase.from('sessions').update({ is_revoked: true }).eq('session_id', req.user.sessionId);
  }
  res.json({ message: 'Logged out' });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('user_id,student_id,full_name,email,role,department')
    .eq('user_id', req.user.userId).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ═══════════════════════════════════════════════════════════
// REQUESTS
// ═══════════════════════════════════════════════════════════

app.get('/api/requests', requireAuth, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('requests').select('*')
    .eq('student_id', req.user.userId)
    .order('submitted_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/api/requests', requireAuth, async (req, res) => {
  if (req.user.role !== 'student')
    return res.status(403).json({ error: 'Students only' });

  const { request_type, subject, reason, course_code, course_name, credits_requested, form_data } = req.body;
  const { count } = await supabase.from('requests').select('*', { count: 'exact', head: true });
  const refNumber = 'REQ' + String((count || 0) + 1).padStart(4, '0');

  const { data, error } = await supabase.from('requests')
    .insert({ ref_number: refNumber, student_id: req.user.userId,
              request_type, subject, reason, course_code, course_name, credits_requested, form_data })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ request: data });
});

app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  const { status, type } = req.query;
  let q = supabase.from('requests')
    .select('*, student:users!requests_student_id_fkey(full_name,student_id,email), admin:users!requests_admin_id_fkey(full_name)')
    .order('submitted_at', { ascending: false });
  if (status) q = q.eq('status', status);
  if (type)   q = q.eq('request_type', type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.put('/api/admin/requests/:id', requireAdmin, async (req, res) => {
  const { status, admin_note } = req.body;
  if (!['approved','denied'].includes(status))
    return res.status(400).json({ error: 'Status must be approved or denied' });
  const { data, error } = await supabase.from('requests')
    .update({ status, admin_note, admin_id: req.user.userId,
              actioned_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('request_id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ request: data });
});

// ═══════════════════════════════════════════════════════════
// FILE UPLOADS
// Storage bucket name: ub-helpdesk-docs  (public bucket)
// Database table:      request_uploads
// ═══════════════════════════════════════════════════════════

const BUCKET = 'ub-helpdesk-docs';

// POST /api/requests/:requestId/uploads
// Multipart form-data — field name: "files" (multiple OK)
// Optional body field: doc_type  (default: "supporting")
app.post('/api/requests/:requestId/uploads', requireAuth, upload.array('files', 10), async (req, res) => {
  const requestId = parseInt(req.params.requestId);

  // Verify the request exists and belongs to this user (or admin)
  const { data: request } = await supabase
    .from('requests').select('request_id,student_id').eq('request_id', requestId).single();

  if (!request)
    return res.status(404).json({ error: 'Request not found' });
  if (req.user.role !== 'admin' && request.student_id !== req.user.userId)
    return res.status(403).json({ error: 'Not authorised to upload to this request' });
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No files received' });

  const docType  = req.body.doc_type || 'supporting';
  const uploaded = [];
  const errors   = [];

  for (const file of req.files) {
    const safeName    = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `requests/${requestId}/${Date.now()}_${safeName}`;

    // 1 — upload bytes to Supabase Storage
    const { error: storageError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });

    if (storageError) {
      errors.push({ file: file.originalname, error: storageError.message });
      continue;
    }

    // 2 — get public URL (bucket must be public)
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

    // 3 — save record in request_uploads table
    const { data: rec, error: dbError } = await supabase
      .from('request_uploads')
      .insert({
        request_id:   requestId,
        uploaded_by:  req.user.userId,
        file_name:    file.originalname,
        file_type:    file.mimetype,
        file_size:    file.size,
        storage_path: storagePath,
        public_url:   urlData.publicUrl,
        doc_type:     docType
      })
      .select().single();

    if (dbError) {
      errors.push({ file: file.originalname, error: dbError.message });
    } else {
      uploaded.push(rec);
    }
  }

  const statusCode = uploaded.length === 0 ? 500 : 201;
  res.status(statusCode).json({
    uploaded,
    errors:  errors.length ? errors : undefined,
    message: `${uploaded.length} file(s) uploaded successfully`
  });
});

// GET /api/requests/:requestId/uploads  — list files for a request
app.get('/api/requests/:requestId/uploads', requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.requestId);
  const { data: request } = await supabase
    .from('requests').select('request_id,student_id').eq('request_id', requestId).single();
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (req.user.role !== 'admin' && request.student_id !== req.user.userId)
    return res.status(403).json({ error: 'Not authorised' });

  const { data, error } = await supabase
    .from('request_uploads').select('*').eq('request_id', requestId).order('uploaded_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ uploads: data });
});

// DELETE /api/uploads/:uploadId  — delete a file (uploader or admin)
app.delete('/api/uploads/:uploadId', requireAuth, async (req, res) => {
  const { data: rec } = await supabase
    .from('request_uploads').select('*').eq('upload_id', req.params.uploadId).single();
  if (!rec) return res.status(404).json({ error: 'Upload not found' });
  if (req.user.role !== 'admin' && rec.uploaded_by !== req.user.userId)
    return res.status(403).json({ error: 'Not authorised' });

  await supabase.storage.from(BUCKET).remove([rec.storage_path]);
  await supabase.from('request_uploads').delete().eq('upload_id', req.params.uploadId);
  res.json({ message: 'Deleted' });
});

// ═══════════════════════════════════════════════════════════
// FAQ
// ═══════════════════════════════════════════════════════════

app.get('/api/faq', async (req, res) => {
  const { category } = req.query;
  let q = supabase.from('faq_entries')
    .select('faq_id,category,question,answer,source')
    .eq('is_published', true).order('category').order('sort_order').order('created_at');
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ faqs: data });
});

app.get('/api/admin/faq', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('faq_entries')
    .select('*, creator:users!faq_entries_created_by_fkey(full_name)')
    .order('category').order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ faqs: data });
});

app.post('/api/admin/faq', requireAdmin, async (req, res) => {
  const { category, question, answer } = req.body;
  const { data, error } = await supabase.from('faq_entries')
    .insert({ category, question, answer, source: 'admin_added', created_by: req.user.userId })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ faq: data });
});

app.put('/api/admin/faq/:id', requireAdmin, async (req, res) => {
  const { category, question, answer, is_published } = req.body;
  const { data, error } = await supabase.from('faq_entries')
    .update({ category, question, answer, is_published, updated_at: new Date().toISOString() })
    .eq('faq_id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ faq: data });
});

app.delete('/api/admin/faq/:id', requireAdmin, async (req, res) => {
  const { data: faq } = await supabase.from('faq_entries').select('source').eq('faq_id', req.params.id).single();
  if (faq?.source === 'registry')
    return res.status(403).json({ error: 'Registry entries cannot be deleted' });
  const { error } = await supabase.from('faq_entries').delete().eq('faq_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

app.post('/api/faq/submit', requireAuth, async (req, res) => {
  const { question, rag_answer, rag_score } = req.body;
  const { data, error } = await supabase.from('faq_submissions')
    .insert({ student_id: req.user.userId, question, rag_answer, rag_score })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ submission: data });
});

app.get('/api/admin/faq/submissions', requireAdmin, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('faq_submissions')
    .select('*, student:users!faq_submissions_student_id_fkey(full_name,student_id)')
    .order('submitted_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ submissions: data });
});

app.put('/api/admin/faq/submissions/:id', requireAdmin, async (req, res) => {
  const { status, official_answer, category } = req.body;
  const updateData = { status, admin_id: req.user.userId, actioned_at: new Date().toISOString() };

  if (status === 'approved') {
    if (!official_answer || !category)
      return res.status(400).json({ error: 'official_answer and category required' });
    const { data: sub } = await supabase.from('faq_submissions')
      .select('question').eq('submission_id', req.params.id).single();
    const { data: faq } = await supabase.from('faq_entries')
      .insert({ category, question: sub.question, answer: official_answer,
                source: 'student_submission', created_by: req.user.userId,
                submission_id: parseInt(req.params.id) })
      .select().single();
    updateData.official_answer = official_answer;
    updateData.category        = category;
    updateData.faq_id          = faq.faq_id;
  }

  const { data, error } = await supabase.from('faq_submissions')
    .update(updateData).eq('submission_id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ submission: data });
});

// ═══════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════

app.get('/api/admin/reports/requests', requireAdmin, async (req, res) => {
  const { data: requests } = await supabase.from('requests').select('status,request_type');
  const total    = requests.length;
  const pending  = requests.filter(r => r.status === 'pending').length;
  const approved = requests.filter(r => r.status === 'approved').length;
  const denied   = requests.filter(r => r.status === 'denied').length;
  const byType   = requests.reduce((a,r) => { a[r.request_type]=(a[r.request_type]||0)+1; return a; }, {});
  res.json({ total, pending, approved, denied, byType });
});

app.get('/api/admin/reports/faq', requireAdmin, async (req, res) => {
  const { data: faqs }        = await supabase.from('faq_entries').select('category,source');
  const { data: submissions } = await supabase.from('faq_submissions')
    .select('*, student:users!faq_submissions_student_id_fkey(full_name,student_id)')
    .order('submitted_at', { ascending: false });
  const byCategory = faqs.reduce((a,f) => { a[f.category]=(a[f.category]||0)+1; return a; }, {});
  const bySource   = faqs.reduce((a,f) => { a[f.source]=(a[f.source]||0)+1; return a; }, {});
  res.json({ total: faqs.length, byCategory, bySource, submissions });
});

// ── Root + health ─────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'running', message: 'UB Help Desk API is live', version: '1.0.0' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\nUB Help Desk API running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health\n`);
});
