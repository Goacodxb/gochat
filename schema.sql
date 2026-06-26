-- GoChat Database Schema
-- Run this against your Railway PostgreSQL instance

-- Availability flag (single row, always exists)
CREATE TABLE IF NOT EXISTS availability (
  id SERIAL PRIMARY KEY,
  is_online BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert the single availability row if it doesn't exist
INSERT INTO availability (id, is_online)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

-- Chat sessions (one per visitor conversation)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_name VARCHAR(255) NOT NULL,
  visitor_email VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'waiting',
  -- status: waiting | active | closed
  claimed_by VARCHAR(255),
  -- Teams user who claimed the chat
  teams_thread_id VARCHAR(500),
  -- Teams conversation/thread ID for routing replies
  teams_activity_id VARCHAR(500),
  -- ID of the Adaptive Card message in Teams
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

-- All messages (visitor + agent)
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_type VARCHAR(50) NOT NULL,
  -- 'visitor' or 'agent'
  sender_name VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Offline lead capture submissions
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS teams_conversation_ref TEXT;
