alter table public.reports add column if not exists incident_campus text;

create index if not exists reports_incident_campus_idx on public.reports (incident_campus);
