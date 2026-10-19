alter table public.reports drop constraint if exists reports_status_check;
alter table public.reports
  add constraint reports_status_check check (status in ('masuk', 'diproses', 'selesai'));

alter table public.follow_ups drop constraint if exists follow_ups_status_new_check;
alter table public.follow_ups
  add constraint follow_ups_status_new_check check (status_new in ('masuk', 'diproses', 'selesai'));

create or replace function public.add_report_follow_up(
  p_report_id uuid,
  p_admin_id uuid,
  p_status text,
  p_note text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status not in ('masuk', 'diproses', 'selesai') then
    raise exception 'Status laporan tidak valid';
  end if;
  if length(trim(p_note)) < 2 or length(p_note) > 1000 then
    raise exception 'Catatan tindak lanjut harus berisi 2-1000 karakter';
  end if;

  update public.reports
  set status = p_status, updated_at = now()
  where id = p_report_id;
  if not found then
    raise exception 'Laporan tidak ditemukan';
  end if;

  insert into public.follow_ups (report_id, admin_id, note, status_new)
  values (p_report_id, p_admin_id, trim(p_note), p_status);
end;
$$;

revoke all on function public.add_report_follow_up(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.add_report_follow_up(uuid, uuid, text, text) to service_role;
