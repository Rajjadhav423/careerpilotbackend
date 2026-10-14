-- Reusable details a user fills in once (GitHub, LinkedIn, LeetCode, portfolio …) and uses in any resume or document
-- as {{key}}. Values are resolved when a PDF or preview is made, so changing one updates every resume.
create table user_fields (
    id         uuid primary key,
    user_id    uuid         not null references users (id) on delete cascade,
    key        varchar(40)  not null,
    label      varchar(60)  not null,
    value      varchar(500) not null,
    position   integer      not null default 0,
    created_at timestamptz  not null default now(),
    updated_at timestamptz  not null,
    constraint user_fields_user_key_key unique (user_id, key)
);

create index user_fields_user_idx on user_fields (user_id, position);
