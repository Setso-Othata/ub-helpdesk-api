-- ============================================================
-- UB Help Desk — Supabase Database Schema
-- IDEMPOTENT VERSION — safe to run multiple times.
-- Run this entire file in: Supabase Dashboard → SQL Editor
-- ============================================================

-- ── 1. ENUMS ─────────────────────────────────────────────────────────────────
-- PostgreSQL has no CREATE TYPE IF NOT EXISTS, so we check pg_type first.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('student', 'admin');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'request_type') THEN
    CREATE TYPE request_type AS ENUM ('extra_credits', 'add_course', 'drop_course', 'change_programme');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'request_status') THEN
    CREATE TYPE request_status AS ENUM ('pending', 'approved', 'denied');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'faq_source') THEN
    CREATE TYPE faq_source AS ENUM ('registry', 'admin_added', 'student_submission');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'submission_status') THEN
    CREATE TYPE submission_status AS ENUM ('pending', 'approved', 'dismissed');
  END IF;
END $$;

-- ── 2. USERS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  user_id       SERIAL PRIMARY KEY,
  student_id    VARCHAR(20)  UNIQUE,
  full_name     VARCHAR(120) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          user_role    NOT NULL DEFAULT 'student',
  department    VARCHAR(100),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_role_idx       ON users (role);
CREATE INDEX IF NOT EXISTS users_student_id_idx ON users (student_id);

-- ── 3. SESSIONS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  session_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER     NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role        user_role   NOT NULL,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '8 hours'),
  is_revoked  BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ── 4. REQUESTS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS requests (
  request_id        SERIAL         PRIMARY KEY,
  ref_number        VARCHAR(12)    NOT NULL UNIQUE,
  student_id        INTEGER        NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  request_type      request_type   NOT NULL,
  subject           VARCHAR(255)   NOT NULL,
  reason            TEXT           NOT NULL,
  course_code       VARCHAR(20),
  course_name       VARCHAR(120),
  credits_requested SMALLINT,
  form_data         TEXT,
  status            request_status NOT NULL DEFAULT 'pending',
  admin_id          INTEGER        REFERENCES users(user_id) ON DELETE SET NULL,
  admin_note        TEXT,
  actioned_at       TIMESTAMPTZ,
  submitted_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS requests_student_idx   ON requests (student_id);
CREATE INDEX IF NOT EXISTS requests_status_idx    ON requests (status);
CREATE INDEX IF NOT EXISTS requests_type_idx      ON requests (request_type);
CREATE INDEX IF NOT EXISTS requests_submitted_idx ON requests (submitted_at);

-- Add form_data column if it was missing from an earlier partial run
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'requests' AND column_name = 'form_data'
  ) THEN
    ALTER TABLE requests ADD COLUMN form_data TEXT;
  END IF;
END $$;

-- ── 5. FAQ ENTRIES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS faq_entries (
  faq_id        SERIAL      PRIMARY KEY,
  category      VARCHAR(80) NOT NULL,
  question      TEXT        NOT NULL,
  answer        TEXT        NOT NULL,
  source        faq_source  NOT NULL DEFAULT 'registry',
  created_by    INTEGER     REFERENCES users(user_id) ON DELETE SET NULL,
  submission_id INTEGER,
  is_published  BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order    SMALLINT    NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS faq_entries_category_idx  ON faq_entries (category);
CREATE INDEX IF NOT EXISTS faq_entries_source_idx    ON faq_entries (source);
CREATE INDEX IF NOT EXISTS faq_entries_published_idx ON faq_entries (is_published);

-- ── 6. FAQ SUBMISSIONS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS faq_submissions (
  submission_id   SERIAL            PRIMARY KEY,
  student_id      INTEGER           NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  question        TEXT              NOT NULL,
  rag_answer      TEXT,
  rag_score       NUMERIC(4,3),
  status          submission_status NOT NULL DEFAULT 'pending',
  admin_id        INTEGER           REFERENCES users(user_id) ON DELETE SET NULL,
  official_answer TEXT,
  category        VARCHAR(80),
  faq_id          INTEGER           REFERENCES faq_entries(faq_id) ON DELETE SET NULL,
  submitted_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  actioned_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS faq_submissions_student_idx ON faq_submissions (student_id);
CREATE INDEX IF NOT EXISTS faq_submissions_status_idx  ON faq_submissions (status);

-- Add FK from faq_entries → faq_submissions (only if not already present)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'faq_entries_submission_fk'
  ) THEN
    ALTER TABLE faq_entries
      ADD CONSTRAINT faq_entries_submission_fk
      FOREIGN KEY (submission_id) REFERENCES faq_submissions(submission_id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 7. DOCUMENTS ─────────────────────────────────────────────────────────────
-- Stores metadata for files uploaded to Supabase Storage.
-- The actual file bytes live in the "ub-helpdesk-docs" Storage bucket.

CREATE TABLE IF NOT EXISTS documents (
  doc_id        SERIAL       PRIMARY KEY,
  request_id    INTEGER      REFERENCES requests(request_id) ON DELETE CASCADE,
  uploaded_by   INTEGER      NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  file_name     VARCHAR(255) NOT NULL,
  file_type     VARCHAR(100) NOT NULL,
  file_size     INTEGER      NOT NULL,          -- bytes
  storage_path  TEXT         NOT NULL UNIQUE,   -- path inside the Storage bucket
  public_url    TEXT         NOT NULL,
  doc_type      VARCHAR(50)  NOT NULL DEFAULT 'supporting',
  uploaded_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_request_idx    ON documents (request_id);
CREATE INDEX IF NOT EXISTS documents_uploader_idx   ON documents (uploaded_by);

-- ── 7. SEED DATA ─────────────────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING means re-running this file never duplicates rows.
--
-- IMPORTANT: The hash below is the well-known Laravel test hash for "password".
-- Replace with real hashes before go-live:
--   node -e "const b=require('bcryptjs'); console.log(b.hashSync('yourpassword',12))"

INSERT INTO users (student_id, full_name, email, password_hash, role, department) VALUES
  ('UB23050001', 'Kefilwe Moeti',   'kefilwe.moeti@ub.ac.bw', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'student', 'Science'),
  ('UB23050002', 'Tebogo Kgosi',    'tebogo.kgosi@ub.ac.bw',  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'student', 'Engineering'),
  ('ADM001',     'Dr. Ruth Sebele', 'ruth.sebele@ub.ac.bw',   '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin',   'Registry')
ON CONFLICT (email) DO NOTHING;

INSERT INTO requests (ref_number, student_id, request_type, subject, reason, course_code, course_name, credits_requested, status, admin_note, actioned_at, submitted_at) VALUES
  ('REQ0001', 1, 'extra_credits', 'Requesting 21 credits total',       'I need to complete my degree on time and require one additional course this semester.', NULL,      NULL,                      21,   'pending',  NULL,                                                                              NULL,                     '2026-01-12 09:00:00+00'),
  ('REQ0002', 1, 'add_course',    'Add CS401 Artificial Intelligence', 'This course is a prerequisite for my final year project.',                               'CS401',   'Artificial Intelligence', NULL, 'approved', 'Approved. Course added to your registration.',                                     '2026-01-09 14:00:00+00', '2026-01-08 10:00:00+00'),
  ('REQ0003', 2, 'drop_course',   'Drop MATH202 Linear Algebra',       'Timetable clash with a core module.',                                                    'MATH202', 'Linear Algebra',          NULL, 'denied',   'Denied. Please resolve the timetable clash through the timetabling office first.', '2025-12-22 11:00:00+00', '2025-12-20 08:00:00+00'),
  ('REQ0004', 2, 'add_course',    'Add STAT201 Statistics I',          'Required for my programme of study.',                                                    'STAT201', 'Statistics I',            NULL, 'pending',  NULL,                                                                              NULL,                     '2026-01-03 08:30:00+00'),
  ('REQ0005', 1, 'drop_course',   'Drop ENG101 Technical Writing',     'Course conflicts with a compulsory lab session.',                                         'ENG101',  'Technical Writing',       NULL, 'approved', 'Approved. Course dropped successfully.',                                           '2026-01-06 10:00:00+00', '2026-01-05 09:00:00+00')
ON CONFLICT (ref_number) DO NOTHING;

INSERT INTO faq_entries (category, question, answer, source, created_by, is_published) VALUES
  ('Course Registration', 'How do I add a course to my registration?',               'Navigate to the Add a Course service page from the sidebar. Review the requirements and visit the Registry Services Office. Additions are only permitted within the first two weeks of semester.',          'registry', 3, true),
  ('Course Registration', 'Can I drop a course after the semester has started?',     'Yes. Drops within Weeks 1 to 2 leave no academic record. After Week 4, a W (Withdrawal) grade is recorded on your transcript.',                                                                          'registry', 3, true),
  ('Course Registration', 'What happens to my fees if I drop a course?',             'If you drop within the first two weeks, you may be eligible for a partial refund. After that period, the full tuition remains payable.',                                                                  'registry', 3, true),
  ('Course Registration', 'What is the deadline to add or drop a course?',           'Course additions close at the end of Week 2. Drops without financial penalty also close at the end of Week 2. After Week 4, a Withdrawal grade is recorded.',                                             'registry', 3, true),
  ('Credit Load',         'What is the standard credit allocation per semester?',    'The standard allocation is 18 credits per semester. Taking more than 18 requires a formal Extra Credits request, subject to a minimum CGPA of 3.0.',                                                      'registry', 3, true),
  ('Credit Load',         'What CGPA do I need to apply for extra credits?',         'A minimum CGPA of 3.0 is required. Students on academic probation are not eligible.',                                                                                                                     'registry', 3, true),
  ('Credit Load',         'How many extra credits can I take?',                      'The maximum overload permitted is typically 21 credits. Requests beyond 21 require exceptional circumstances and Dean approval.',                                                                          'registry', 3, true),
  ('Programme Changes',   'How long does a programme change take to process?',       'Programme change requests take up to 15 working days to process after submission.',                                                                                                                        'registry', 3, true),
  ('Programme Changes',   'Will my completed credits transfer if I change programmes?', 'Credits may be recognised by the receiving department at their discretion. A credit recognition assessment is conducted as part of the review.',                                                     'registry', 3, true),
  ('Programme Changes',   'What documents do I need to change my programme?',        'You need a formal motivation letter, approval from your current Faculty, and acceptance from the receiving Faculty.',                                                                                      'registry', 3, true),
  ('General',             'How do I track the status of my request?',                'Track requests under My Requests in the sidebar — listed as Pending, Approved, or Denied with full details and any admin notes.',                                                                         'registry', 3, true),
  ('General',             'Who do I contact if my request is denied?',               'You have the right to appeal within 5 working days. Contact the Faculty Dean Office with supporting documentation.',                                                                                       'registry', 3, true),
  ('General',             'What are Registry Services office hours?',                'Registry Services contact details are to be updated. Please check the Help Desk portal or contact your faculty for the latest information.',                                                               'registry', 3, true),
  ('General',             'How long does it take to process a request?',             'Add/Drop: 3-5 working days. Extra credits: 5-7 working days. Programme change: up to 15 working days.',                                                                                                   'registry', 3, true)
ON CONFLICT DO NOTHING;

-- ── 8. REQUEST UPLOADS ───────────────────────────────────────────────────────
-- Stores metadata for files uploaded against a request.
-- Actual file bytes live in the Supabase Storage bucket: ub-helpdesk-docs

CREATE TABLE IF NOT EXISTS request_uploads (
  upload_id     SERIAL       PRIMARY KEY,
  request_id    INTEGER      NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
  uploaded_by   INTEGER      NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  file_name     VARCHAR(255) NOT NULL,
  file_type     VARCHAR(100) NOT NULL,
  file_size     INTEGER      NOT NULL,
  storage_path  TEXT         NOT NULL UNIQUE,
  public_url    TEXT         NOT NULL,
  doc_type      VARCHAR(50)  NOT NULL DEFAULT 'supporting',
  uploaded_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS uploads_request_idx  ON request_uploads (request_id);
CREATE INDEX IF NOT EXISTS uploads_uploader_idx ON request_uploads (uploaded_by);
