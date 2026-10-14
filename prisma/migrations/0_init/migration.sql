-- Baseline: the schema the Spring backend (Flyway V1–V9) created. On the existing database mark it applied:
--   npx prisma migrate resolve --applied 0_init

-- People who can sign in (accounts live in Clerk; this row links a Clerk user to CareerPilot data)
create table users (
    id                uuid primary key,
    clerk_user_id     varchar(64)   not null,
    email             varchar(320),
    display_name      varchar(100),
    avatar_url        varchar(2048),
    last_signed_in_at timestamptz,
    created_at        timestamptz   not null,
    updated_at        timestamptz   not null,
    constraint users_email_lowercase check (email = lower(email)),
    constraint users_clerk_user_id_key unique (clerk_user_id)
);
create index users_email_idx on users (email);

-- Jobs a user is tracking
create table jobs (
    id          uuid primary key,
    user_id     uuid          not null references users (id) on delete cascade,
    title       varchar(200)  not null,
    company     varchar(200)  not null,
    location    varchar(200),
    work_mode   varchar(16),
    job_url     varchar(2048),
    description text,
    notes       text,
    status      varchar(20)   not null,
    -- MANUAL, or the job board (GREENHOUSE / LEVER / ASHBY …) when saved from Find jobs
    source      varchar(32)   not null,
    -- The Find-jobs posting id, so the same posting can't be saved twice
    external_id varchar(200),
    archived    boolean       not null default false,
    applied_at  timestamptz,
    created_at  timestamptz   not null,
    updated_at  timestamptz   not null,
    constraint jobs_status_check check (status in
        ('SAVED', 'TO_REVIEW', 'PREPARING', 'APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'CLOSED')),
    constraint jobs_work_mode_check check (work_mode in ('ONSITE', 'HYBRID', 'REMOTE'))
);
create index jobs_user_active_idx on jobs (user_id, updated_at desc) where not archived;
create unique index jobs_user_external_id_key on jobs (user_id, external_id) where external_id is not null;

-- Reusable email templates; at most one default per user
create table email_templates (
    id         uuid primary key,
    user_id    uuid         not null references users (id) on delete cascade,
    name       varchar(100) not null,
    subject    varchar(255) not null,
    body       text         not null,
    is_default boolean      not null default false,
    created_at timestamptz  not null,
    updated_at timestamptz  not null
);
create index email_templates_user_idx on email_templates (user_id, updated_at desc);
create unique index email_templates_one_default_per_user on email_templates (user_id) where is_default;

-- Application emails Gmail accepted (the body is not stored)
create table sent_emails (
    id               uuid primary key,
    user_id          uuid         not null references users (id) on delete cascade,
    job_id           uuid         references jobs (id) on delete set null,
    template_id      uuid         references email_templates (id) on delete set null,
    recipient        varchar(320) not null,
    subject          varchar(255) not null,
    gmail_message_id varchar(128) not null,
    gmail_thread_id  varchar(128),
    sent_at          timestamptz  not null
);
create index sent_emails_user_job_idx on sent_emails (user_id, job_id, sent_at desc);

-- Resumes: form content (data) and, optionally, a docEngine document that is what gets rendered
create table resumes (
    id          uuid primary key,
    user_id     uuid         not null references users (id) on delete cascade,
    title       varchar(120) not null,
    template_id varchar(40)  not null,
    page_size   varchar(10)  not null,
    data        jsonb        not null,
    document    jsonb,
    created_at  timestamptz  not null,
    updated_at  timestamptz  not null
);
create index resumes_user_updated_idx on resumes (user_id, updated_at desc);

-- Resume history and proposals (used when RESUME_VERSIONS_ENABLED=true)
create table resume_versions (
    id          uuid primary key,
    resume_id   uuid         not null references resumes (id) on delete cascade,
    user_id     uuid         not null references users (id) on delete cascade,
    number      integer      not null,
    label       varchar(120),
    source      varchar(20)  not null,
    status      varchar(20)  not null,
    template_id varchar(40)  not null,
    page_size   varchar(10)  not null,
    data        jsonb        not null,
    document    jsonb,
    created_at  timestamptz  not null,
    constraint resume_versions_number_key unique (resume_id, number)
);
create index resume_versions_resume_idx on resume_versions (resume_id, number desc);

-- Per-user Google Drive preferences (no credentials: Google tokens stay with Clerk)
create table drive_settings (
    user_id      uuid primary key references users (id) on delete cascade,
    enabled      boolean      not null default true,
    google_email varchar(320),
    folder_id    varchar(128),
    folder_name  varchar(255),
    updated_at   timestamptz  not null
);

-- Files CareerPilot created in the user's Drive (deleting a row never deletes the Drive file)
create table drive_documents (
    id            uuid primary key,
    user_id       uuid          not null references users (id) on delete cascade,
    drive_file_id varchar(128)  not null,
    name          varchar(255)  not null,
    folder_id     varchar(128),
    mime_type     varchar(100)  not null,
    size_bytes    bigint,
    web_view_link varchar(2048),
    request_id    uuid,
    resume_id     uuid          references resumes (id) on delete set null,
    created_at    timestamptz   not null,
    updated_at    timestamptz   not null,
    constraint drive_documents_user_file_key unique (user_id, drive_file_id),
    constraint drive_documents_user_request_key unique (user_id, request_id)
);
create index drive_documents_user_updated_idx on drive_documents (user_id, updated_at desc);
