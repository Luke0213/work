-- Allow the anonymous internal trial client to delete only files in the SPC bucket/path.
create policy "SPC photos anonymous delete"
on storage.objects for delete
to anon, authenticated
using (bucket_id='spc-photos' and (storage.foldername(name))[1]='spc');
