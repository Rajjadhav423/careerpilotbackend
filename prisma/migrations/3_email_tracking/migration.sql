-- Tracking for application emails: delivery (no bounce), opens (tracking pixel) and replies (Gmail thread headers).
alter table sent_emails
  add column delivery_status varchar(16) not null default 'SENT',
  add column bounced_at timestamptz(6),
  add column tracking_token varchar(64),
  add column open_count integer not null default 0,
  add column first_opened_at timestamptz(6),
  add column last_opened_at timestamptz(6),
  add column reply_count integer not null default 0,
  add column replied_at timestamptz(6),
  add column checked_at timestamptz(6);

create unique index sent_emails_tracking_token_key on sent_emails (tracking_token);
