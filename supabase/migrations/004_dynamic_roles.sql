create table if not exists public.roles (
  name text primary key check (length(name) between 2 and 40),
  created_at timestamptz not null default now()
);

alter table public.roles enable row level security;

insert into public.roles (name) values
  ('Admin'), ('PKKM'), ('PKM'), ('ASUS'), ('Akademik'),
  ('Kemahasiswaan FTE'), ('Kemahasiswaan FIF'), ('Kemahasiswaan FRI'),
  ('Kemahasiswa FKS'), ('Kemahasiswaan FKB'), ('Kemahasiswaan FIK'),
  ('Kemahasiswaan FIT'), ('Kemahasiswaan FK'), ('Kemahasiswaan TUJ'),
  ('Kemahasiswaan TUS'), ('Kemahasiswaan TUP')
on conflict do nothing;

-- Daftar peran tetap di CHECK diganti foreign key ke tabel roles (rename ikut terbawa, hapus ditahan bila dipakai).
do $$
declare c record;
begin
  for c in
    select con.conname, rel.relname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and con.contype = 'c'
      and ((rel.relname = 'profiles' and pg_get_constraintdef(con.oid) like '%role%')
        or (rel.relname = 'reports' and pg_get_constraintdef(con.oid) like '%assigned_role%'))
  loop
    execute format('alter table public.%I drop constraint %I', c.relname, c.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_fkey foreign key (role) references public.roles (name) on update cascade on delete restrict;
alter table public.reports
  add constraint reports_assigned_role_fkey foreign key (assigned_role) references public.roles (name) on update cascade on delete restrict;

-- Riwayat tindak lanjut tetap ada walau akun petugas dihapus.
alter table public.follow_ups alter column admin_id drop not null;
alter table public.follow_ups drop constraint if exists follow_ups_admin_id_fkey;
alter table public.follow_ups
  add constraint follow_ups_admin_id_fkey foreign key (admin_id) references public.profiles (id) on delete set null;
