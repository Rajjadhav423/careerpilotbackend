-- The assistant's own tailored copy of a resume (used for job applications), kept apart from the resumes the user
-- writes so tailoring never changes them. At most one per user.
alter table resumes add column ai_copy boolean not null default false;

create unique index resumes_one_ai_copy_per_user on resumes (user_id) where ai_copy;
