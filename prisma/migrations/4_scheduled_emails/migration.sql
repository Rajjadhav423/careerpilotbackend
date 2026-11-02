-- Scheduled application emails: each waits as a draft in the user's Gmail until send_at, then the run endpoint sends it.
create table scheduled_emails (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  job_id uuid not null references jobs (id) on delete cascade,
  template_id uuid,
  recipient varchar(320) not null,
  subject varchar(255) not null,
  gmail_draft_id varchar(128) not null,
  send_at timestamptz(6) not null,
  status varchar(16) not null default 'SCHEDULED',
  error varchar(500),
  tracking_token varchar(64),
  sent_email_id uuid,
  created_at timestamptz(6) not null default now(),
  updated_at timestamptz(6) not null
);

create index scheduled_emails_due_idx on scheduled_emails (status, send_at);
create index scheduled_emails_user_idx on scheduled_emails (user_id, send_at);
